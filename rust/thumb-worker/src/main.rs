use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tagimage_core::{
    decode_supported_image, expected_format_for_path, file_fingerprint, parse_u64_env,
    parse_usize_env, DecodedImage, FileIssueSeverity, ImageInspectionError,
    ImageInspectionErrorKind, ThumbJobPayload,
};
use tagimage_db::sqlite::{
    claim_next_sqlite_thumb_job, finalize_sqlite_thumb_success, get_sqlite_file_issue_for_image,
    mark_sqlite_claimed_job_terminal_failed, mark_sqlite_image_job_terminal_failed,
    mark_sqlite_thumb_failed, open_sqlite_worker_db, record_sqlite_permanent_image_job_failure,
    resolve_sqlite_runtime_path, SqliteDecodedImageRecovery, SqliteFileIssueUpsert,
};
use tagimage_db::ClaimedJob;
use tokio::time::sleep;

#[derive(Debug, Clone)]
struct ThumbJobMetrics {
    image_id: Option<String>,
    ext: String,
    total_ms: u128,
    render_ms: u128,
    source_bytes: Option<u64>,
    thumb_bytes: Option<u64>,
    skipped_existing: bool,
}

#[derive(Debug)]
struct WorkerMetrics {
    processed: u64,
    succeeded: u64,
    failed: u64,
    skipped: u64,
    total_ms_sum: u128,
    render_ms_sum: u128,
    slowest_ms: u128,
    started_at: Instant,
    last_summary_at: Instant,
}

impl WorkerMetrics {
    fn new() -> Self {
        let now = Instant::now();
        Self {
            processed: 0,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            total_ms_sum: 0,
            render_ms_sum: 0,
            slowest_ms: 0,
            started_at: now,
            last_summary_at: now,
        }
    }

    fn record_success(&mut self, job: &ThumbJobMetrics) {
        self.processed += 1;
        self.succeeded += 1;
        if job.skipped_existing {
            self.skipped += 1;
        }
        self.total_ms_sum += job.total_ms;
        self.render_ms_sum += job.render_ms;
        self.slowest_ms = self.slowest_ms.max(job.total_ms);
    }

    fn record_failure(&mut self, total_ms: u128) {
        self.processed += 1;
        self.failed += 1;
        self.total_ms_sum += total_ms;
        self.slowest_ms = self.slowest_ms.max(total_ms);
    }

    fn maybe_log_summary(&mut self, interval_sec: u64, workers: usize) {
        if interval_sec == 0 {
            return;
        }
        if self.last_summary_at.elapsed() < Duration::from_secs(interval_sec) {
            return;
        }
        self.last_summary_at = Instant::now();

        let avg_ms = if self.processed > 0 {
            (self.total_ms_sum / (self.processed as u128)) as u64
        } else {
            0
        };
        let avg_render_ms = if self.processed > 0 {
            (self.render_ms_sum / (self.processed as u128)) as u64
        } else {
            0
        };

        let elapsed_sec = self.started_at.elapsed().as_secs_f64();
        let thumbs_per_sec = if elapsed_sec > 0.0 {
            self.succeeded as f64 / elapsed_sec
        } else {
            0.0
        };

        eprintln!(
            "[rust-thumb-worker] metrics workers={} processed={} succeeded={} failed={} skipped={} avg_ms={} avg_render_ms={} thumbs_per_sec={:.2} slowest_ms={}",
            workers,
            self.processed,
            self.succeeded,
            self.failed,
            self.skipped,
            avg_ms,
            avg_render_ms,
            thumbs_per_sec,
            self.slowest_ms
        );
    }
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn file_mtime(path: &Path) -> Option<i64> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?;
    modified
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

fn file_size(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|m| m.len())
}

fn parse_max_size(payload: &ThumbJobPayload) -> (u32, u32) {
    if let Some(parts) = &payload.max_size {
        if parts.len() >= 2 {
            let w = parts[0].max(32);
            let h = parts[1].max(32);
            return (w, h);
        }
    }
    (640, 640)
}

fn ext_lower(source: &Path) -> String {
    source
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn fmt_opt_u64(value: Option<u64>) -> String {
    value
        .map(|v| v.to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn lock_worker_metrics(metrics: &Arc<Mutex<WorkerMetrics>>) -> MutexGuard<'_, WorkerMetrics> {
    match metrics.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn render_thumb(
    dyn_img: image::DynamicImage,
    target: &Path,
    max_size: (u32, u32),
) -> Result<(), String> {
    let thumb = dyn_img.thumbnail(max_size.0, max_size.1).to_rgb8();

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir {}: {e}", parent.display()))?;
    }

    let file =
        fs::File::create(target).map_err(|e| format!("create thumb {}: {e}", target.display()))?;
    let mut writer = BufWriter::new(file);
    let mut encoder = JpegEncoder::new_with_quality(&mut writer, 86);
    encoder
        .encode(
            &thumb,
            thumb.width(),
            thumb.height(),
            ColorType::Rgb8.into(),
        )
        .map_err(|e| format!("encode jpeg {}: {e}", target.display()))?;
    writer
        .flush()
        .map_err(|e| format!("flush thumb {}: {e}", target.display()))?;
    Ok(())
}

fn publish_thumb(temp: &Path, target: &Path) -> Result<(), String> {
    match fs::rename(temp, target) {
        Ok(()) => Ok(()),
        Err(first_error) if target.exists() => {
            fs::remove_file(target)
                .map_err(|error| format!("replace thumb {}: {error}", target.display()))?;
            fs::rename(temp, target).map_err(|error| {
                format!(
                    "publish thumb {} -> {} after replace ({first_error}): {error}",
                    temp.display(),
                    target.display()
                )
            })
        }
        Err(error) => Err(format!(
            "publish thumb {} -> {}: {error}",
            temp.display(),
            target.display()
        )),
    }
}

fn process_payload(
    payload: Value,
) -> Result<(ThumbJobPayload, PathBuf, PathBuf, (u32, u32)), String> {
    let parsed: ThumbJobPayload =
        serde_json::from_value(payload).map_err(|e| format!("invalid payload: {e}"))?;
    let source = Path::new(&parsed.root_path).join(&parsed.path);
    let target = Path::new(&parsed.root_path).join(&parsed.thumb);
    let max_size = parse_max_size(&parsed);
    Ok((parsed, source, target, max_size))
}

#[derive(Debug)]
enum ThumbExecution {
    Succeeded(ThumbJobMetrics),
    Failed { error: String, total_ms: u128 },
    Discarded { reason: String, total_ms: u128 },
}

fn failed_or_discarded(applied: bool, error: String, total_ms: u128) -> ThumbExecution {
    if applied {
        ThumbExecution::Failed { error, total_ms }
    } else {
        ThumbExecution::Discarded {
            reason: error,
            total_ms,
        }
    }
}

fn thumb_attempt_temp_path(target: &Path, job: &ClaimedJob) -> PathBuf {
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("thumbnail.jpg");
    target.with_file_name(format!(".{name}.{}.{}.tmp", job.id, job.attempt))
}

fn execute_thumb_job(
    conn: &rusqlite::Connection,
    job: &ClaimedJob,
    max_backoff_sec: i64,
) -> Result<ThumbExecution, String> {
    execute_thumb_job_with_decoder(conn, job, max_backoff_sec, decode_supported_image)
}

fn execute_thumb_job_with_decoder<F>(
    conn: &rusqlite::Connection,
    job: &ClaimedJob,
    max_backoff_sec: i64,
    decoder: F,
) -> Result<ThumbExecution, String>
where
    F: FnOnce(&Path) -> Result<DecodedImage, ImageInspectionError>,
{
    execute_thumb_job_with_decoder_and_publisher(conn, job, max_backoff_sec, decoder, publish_thumb)
}

fn execute_thumb_job_with_decoder_and_publisher<F, P>(
    conn: &rusqlite::Connection,
    job: &ClaimedJob,
    max_backoff_sec: i64,
    decoder: F,
    publisher: P,
) -> Result<ThumbExecution, String>
where
    F: FnOnce(&Path) -> Result<DecodedImage, ImageInspectionError>,
    P: FnOnce(&Path, &Path) -> Result<(), String>,
{
    let started = Instant::now();
    let (payload, source, target, max_size) = match process_payload(job.payload.clone()) {
        Ok(value) => value,
        Err(error) => {
            let applied = mark_sqlite_claimed_job_terminal_failed(
                conn,
                job,
                &error,
                Some(started.elapsed().as_millis()),
            )?;
            let total_ms = started.elapsed().as_millis();
            return Ok(failed_or_discarded(applied, error, total_ms));
        }
    };
    let Some(image_id) = payload.image_id.as_deref() else {
        let error = "thumbnail job has no image_id".to_string();
        let applied = mark_sqlite_claimed_job_terminal_failed(
            conn,
            job,
            &error,
            Some(started.elapsed().as_millis()),
        )?;
        let total_ms = started.elapsed().as_millis();
        return Ok(failed_or_discarded(applied, error, total_ms));
    };
    if expected_format_for_path(&source).is_none() {
        let error = format!("unsupported image job path: {}", source.display());
        let applied = mark_sqlite_claimed_job_terminal_failed(
            conn,
            job,
            &error,
            Some(started.elapsed().as_millis()),
        )?;
        let total_ms = started.elapsed().as_millis();
        return Ok(failed_or_discarded(applied, error, total_ms));
    }

    let fingerprint = match file_fingerprint(&source) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            let total_ms = started.elapsed().as_millis();
            let detail = error.detail;
            let applied =
                mark_sqlite_thumb_failed(conn, job, &detail, max_backoff_sec, Some(total_ms))?;
            return Ok(failed_or_discarded(applied, detail, total_ms));
        }
    };
    let existing_issue =
        get_sqlite_file_issue_for_image(conn, image_id, &payload.root_path, &payload.path)?;
    if let Some(issue) = &existing_issue {
        if issue.severity == FileIssueSeverity::Error
            && issue.size == fingerprint.size
            && issue.mtime_ns == fingerprint.mtime_ns
        {
            let error = format!("image unavailable: {}", issue.kind.as_str());
            let total_ms = started.elapsed().as_millis();
            let applied =
                mark_sqlite_image_job_terminal_failed(conn, job, image_id, &error, Some(total_ms))?;
            return Ok(failed_or_discarded(applied, error, total_ms));
        }
    }

    let decoded = match decoder(&source) {
        Ok(decoded) => decoded,
        Err(error) => {
            let total_ms = started.elapsed().as_millis();
            let applied = match error.kind {
                ImageInspectionErrorKind::DecodeError
                | ImageInspectionErrorKind::UnsupportedContent => {
                    let issue = permanent_issue_from_error(&payload, image_id, &error)?;
                    record_sqlite_permanent_image_job_failure(
                        conn,
                        job,
                        image_id,
                        &issue,
                        &error.detail,
                        Some(total_ms),
                    )?
                }
                ImageInspectionErrorKind::UnsupportedPath => {
                    mark_sqlite_claimed_job_terminal_failed(
                        conn,
                        job,
                        &error.detail,
                        Some(total_ms),
                    )?
                }
                ImageInspectionErrorKind::Unreadable
                    if job.attempt >= job.max_attempts && error.fingerprint.is_some() =>
                {
                    let issue = permanent_issue_from_error(&payload, image_id, &error)?;
                    record_sqlite_permanent_image_job_failure(
                        conn,
                        job,
                        image_id,
                        &issue,
                        &error.detail,
                        Some(total_ms),
                    )?
                }
                ImageInspectionErrorKind::ChangedDuringInspection
                | ImageInspectionErrorKind::Unreadable => mark_sqlite_thumb_failed(
                    conn,
                    job,
                    &error.detail,
                    max_backoff_sec,
                    Some(total_ms),
                )?,
            };
            return Ok(failed_or_discarded(applied, error.detail, total_ms));
        }
    };

    let decoded_width = decoded.image.width().min(i32::MAX as u32) as i32;
    let decoded_height = decoded.image.height().min(i32::MAX as u32) as i32;
    let recovery = existing_issue.as_ref().and_then(|issue| {
        (issue.severity == FileIssueSeverity::Error
            && (issue.size != decoded.fingerprint.size
                || issue.mtime_ns != decoded.fingerprint.mtime_ns))
            .then(|| SqliteDecodedImageRecovery {
                image_id: image_id.to_string(),
                root_path: payload.root_path.clone(),
                path: payload.path.clone(),
                expected_format: decoded.expected_format,
                detected_format: decoded.detected_format,
                fingerprint: decoded.fingerprint,
                width: decoded_width,
                height: decoded_height,
            })
    });
    let source_mtime = payload.mtime.unwrap_or(decoded.fingerprint.mtime);
    let source_bytes = Some(decoded.fingerprint.size.max(0) as u64);
    let mut skipped_existing = false;
    let mut render_ms = 0_u128;
    if recovery.is_none() {
        if let Some(current_mtime) = file_mtime(&target) {
            if current_mtime >= source_mtime {
                skipped_existing = true;
            }
        }
    }
    let temp_target = (!skipped_existing).then(|| thumb_attempt_temp_path(&target, job));
    if !skipped_existing {
        let render_started = Instant::now();
        if let Err(error) = render_thumb(
            decoded.image,
            temp_target.as_ref().expect("thumbnail temp path"),
            max_size,
        ) {
            if let Some(temp_target) = &temp_target {
                let _ = fs::remove_file(temp_target);
            }
            let total_ms = started.elapsed().as_millis();
            let applied =
                mark_sqlite_thumb_failed(conn, job, &error, max_backoff_sec, Some(total_ms))?;
            return Ok(failed_or_discarded(applied, error, total_ms));
        }
        render_ms = render_started.elapsed().as_millis();
    }
    let total_ms = started.elapsed().as_millis();
    let metrics = ThumbJobMetrics {
        image_id: Some(image_id.to_string()),
        ext: ext_lower(&source),
        total_ms,
        render_ms,
        source_bytes,
        thumb_bytes: temp_target
            .as_deref()
            .and_then(file_size)
            .or_else(|| file_size(&target)),
        skipped_existing,
    };
    let event_data = json!({
        "total_ms": metrics.total_ms.min(u64::MAX as u128) as u64,
        "render_ms": metrics.render_ms.min(u64::MAX as u128) as u64,
        "source_bytes": metrics.source_bytes,
        "thumb_bytes": metrics.thumb_bytes,
        "skipped_existing": metrics.skipped_existing,
        "ext": &metrics.ext,
    });
    let mut publish_failure = None;
    let finalize_result =
        finalize_sqlite_thumb_success(conn, job, Some(event_data), recovery.as_ref(), || {
            if let Some(temp_target) = &temp_target {
                if let Err(error) = publisher(temp_target, &target) {
                    publish_failure = Some(error.clone());
                    return Err(error);
                }
            }
            Ok(())
        });
    let applied = match finalize_result {
        Ok(applied) => applied,
        Err(error) => {
            let Some(publish_error) = publish_failure else {
                return Err(error);
            };
            if let Some(temp_target) = &temp_target {
                let _ = fs::remove_file(temp_target);
            }
            let total_ms = started.elapsed().as_millis();
            let error = format!("publish thumbnail: {publish_error}");
            let applied =
                mark_sqlite_thumb_failed(conn, job, &error, max_backoff_sec, Some(total_ms))?;
            return Ok(failed_or_discarded(applied, error, total_ms));
        }
    };
    if !applied {
        if let Some(temp_target) = &temp_target {
            let _ = fs::remove_file(temp_target);
        }
        return Ok(ThumbExecution::Discarded {
            reason: "thumbnail attempt is no longer current".to_string(),
            total_ms,
        });
    }
    Ok(ThumbExecution::Succeeded(metrics))
}

fn permanent_issue_from_error(
    payload: &ThumbJobPayload,
    image_id: &str,
    error: &ImageInspectionError,
) -> Result<SqliteFileIssueUpsert, String> {
    let kind = error
        .file_issue_kind()
        .ok_or_else(|| format!("non-permanent image error: {}", error.detail))?;
    let fingerprint = error
        .fingerprint
        .ok_or_else(|| format!("permanent image error has no fingerprint: {}", error.detail))?;
    Ok(SqliteFileIssueUpsert {
        image_id: Some(image_id.to_string()),
        root_path: payload.root_path.clone(),
        path: payload.path.clone(),
        severity: FileIssueSeverity::Error,
        kind,
        expected_format: error.expected_format,
        detected_format: error.detected_format.clone(),
        size: fingerprint.size,
        mtime_ns: fingerprint.mtime_ns,
        detail: Some(error.detail.clone()),
    })
}

async fn run_worker_loop(
    db_path: PathBuf,
    worker_id: String,
    slot: usize,
    worker_count: usize,
    poll_ms: u64,
    max_backoff_sec: i64,
    metrics_interval_sec: u64,
    slow_ms: u128,
    shared_metrics: Arc<Mutex<WorkerMetrics>>,
) -> Result<(), String> {
    let conn = open_sqlite_worker_db(&db_path)
        .map_err(|e| format!("open sqlite db {} (slot={}): {e}", db_path.display(), slot))?;

    eprintln!(
        "[rust-thumb-worker] loop_started worker={} slot={}",
        worker_id, slot
    );

    loop {
        let claimed = claim_next_sqlite_thumb_job(&conn, &worker_id).map_err(|error| {
            format!("claim sqlite thumb job worker={worker_id} slot={slot}: {error}")
        })?;
        let Some(job) = claimed else {
            {
                let mut worker_metrics = lock_worker_metrics(&shared_metrics);
                worker_metrics.maybe_log_summary(metrics_interval_sec, worker_count);
            }
            sleep(Duration::from_millis(poll_ms)).await;
            continue;
        };

        match execute_thumb_job(&conn, &job, max_backoff_sec)? {
            ThumbExecution::Succeeded(job_metrics) => {
                let image = job_metrics.image_id.as_deref().unwrap_or("unknown");
                eprintln!(
                    "[rust-thumb-worker] job_done worker={} slot={} job={} image={} ext={} total_ms={} render_ms={} source_bytes={} thumb_bytes={} skipped={}",
                    worker_id,
                    slot,
                    job.id,
                    image,
                    job_metrics.ext,
                    job_metrics.total_ms,
                    job_metrics.render_ms,
                    fmt_opt_u64(job_metrics.source_bytes),
                    fmt_opt_u64(job_metrics.thumb_bytes),
                    job_metrics.skipped_existing
                );

                if job_metrics.total_ms >= slow_ms {
                    eprintln!(
                        "[rust-thumb-worker] slow_job worker={} slot={} job={} image={} ext={} total_ms={} render_ms={}",
                        worker_id,
                        slot,
                        job.id,
                        image,
                        job_metrics.ext,
                        job_metrics.total_ms,
                        job_metrics.render_ms
                    );
                }

                {
                    let mut worker_metrics = lock_worker_metrics(&shared_metrics);
                    worker_metrics.record_success(&job_metrics);
                    worker_metrics.maybe_log_summary(metrics_interval_sec, worker_count);
                }
            }
            ThumbExecution::Failed { error, total_ms } => {
                eprintln!(
                    "[rust-thumb-worker] job_failed worker={} slot={} job={} total_ms={} error={}",
                    worker_id, slot, job.id, total_ms, error
                );
                {
                    let mut worker_metrics = lock_worker_metrics(&shared_metrics);
                    worker_metrics.record_failure(total_ms);
                    worker_metrics.maybe_log_summary(metrics_interval_sec, worker_count);
                }
            }
            ThumbExecution::Discarded { reason, total_ms } => {
                eprintln!(
                    "[rust-thumb-worker] job_discarded worker={} slot={} job={} total_ms={} reason={}",
                    worker_id, slot, job.id, total_ms, reason
                );
            }
        }
    }
}

async fn run() -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    if !matches!(
        std::env::var("TAGIMAGE_PACKAGED_RUNTIME").as_deref(),
        Ok("1" | "true" | "yes")
    ) {
        let _ = dotenvy::from_path(repo_root.join(".env"));
    }
    let db_path = resolve_sqlite_runtime_path(&repo_root);
    let poll_ms = std::env::var("IMGVIEWER_THUMB_WORKER_POLL_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(750)
        .max(50);
    let worker_id = std::env::var("IMGVIEWER_THUMB_WORKER_ID")
        .unwrap_or_else(|_| format!("rust-thumb-{}", now_unix()));
    let max_backoff_sec = std::env::var("IMGVIEWER_THUMB_MAX_BACKOFF_SEC")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(300)
        .max(1);
    let worker_count = parse_usize_env("IMGVIEWER_THUMB_WORKERS", 1);
    let metrics_interval_sec = parse_u64_env("IMGVIEWER_THUMB_METRICS_INTERVAL_SEC", 30);
    let slow_ms = parse_u64_env("IMGVIEWER_THUMB_SLOW_MS", 1000) as u128;

    eprintln!(
        "[rust-thumb-worker] started as {} workers={} sqlite={}",
        worker_id,
        worker_count,
        db_path.display()
    );

    let shared_metrics = Arc::new(Mutex::new(WorkerMetrics::new()));
    let mut workers = tokio::task::JoinSet::new();

    for slot in 1..=worker_count {
        workers.spawn(run_worker_loop(
            db_path.clone(),
            worker_id.clone(),
            slot,
            worker_count,
            poll_ms,
            max_backoff_sec,
            metrics_interval_sec,
            slow_ms,
            Arc::clone(&shared_metrics),
        ));
    }

    while let Some(result) = workers.join_next().await {
        match result {
            Ok(Ok(())) => {
                return Err("worker loop exited unexpectedly".to_string());
            }
            Ok(Err(err)) => return Err(err),
            Err(err) => return Err(format!("worker loop join error: {err}")),
        }
    }

    Err("all worker loops exited unexpectedly".to_string())
}

fn resolve_repo_root() -> Result<PathBuf, String> {
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join("static/index.html").exists() && cwd.join("rust").is_dir() {
            return Ok(cwd);
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .ok_or_else(|| "cannot resolve repo root".to_string())
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("[rust-thumb-worker] fatal: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;
    use tagimage_core::{
        file_fingerprint, inspect_supported_image, FileFingerprint, FileIssueKind,
        SupportedImageFormat,
    };
    use tagimage_db::sqlite::{
        cancel_sqlite_job, enqueue_sqlite_job, enqueue_sqlite_thumb_job, get_sqlite_file_issue,
        get_sqlite_image_by_id, get_sqlite_job, init_sqlite_db, list_sqlite_job_events,
        list_sqlite_tags_for_image, replace_sqlite_image_tags, upsert_sqlite_file_issue,
        upsert_sqlite_image, SqliteImageUpsert,
    };

    fn encoded(format: ImageFormat) -> Vec<u8> {
        encoded_with_dimensions(format, 8, 6)
    }

    fn encoded_with_dimensions(format: ImageFormat, width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb([20, 40, 60])));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }

    fn corrupt_png_pixels() -> Vec<u8> {
        let mut bytes = encoded(ImageFormat::Png);
        let chunk_type = bytes
            .windows(4)
            .position(|window| window == b"IDAT")
            .expect("IDAT chunk");
        bytes[chunk_type + 5] ^= 0x7f;
        bytes
    }

    fn setup_claimed_thumb(
        root: &Path,
        conn: &rusqlite::Connection,
        image_id: &str,
        path: &str,
        contents: &[u8],
    ) -> (ClaimedJob, PathBuf) {
        setup_claimed_thumb_with_attempts(root, conn, image_id, path, contents, 3)
    }

    fn setup_claimed_thumb_with_attempts(
        root: &Path,
        conn: &rusqlite::Connection,
        image_id: &str,
        path: &str,
        contents: &[u8],
        max_attempts: i32,
    ) -> (ClaimedJob, PathBuf) {
        let source = root.join(path);
        if let Some(parent) = source.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&source, contents).unwrap();
        let fingerprint = file_fingerprint(&source).unwrap();
        let thumb = format!(".imgindex/thumbs/{image_id}.jpg");
        upsert_sqlite_image(
            conn,
            &SqliteImageUpsert {
                id: Some(image_id.to_string()),
                root_path: root.to_string_lossy().to_string(),
                path: path.to_string(),
                thumb: thumb.clone(),
                size: fingerprint.size,
                mtime: fingerprint.mtime,
                width: 8,
                height: 6,
                ext: ext_lower(&source),
            },
        )
        .unwrap();
        enqueue_sqlite_thumb_job(
            conn,
            image_id,
            &root.to_string_lossy(),
            path,
            &thumb,
            fingerprint.mtime,
            20,
            max_attempts,
        )
        .unwrap();
        let claimed = claim_next_sqlite_thumb_job(conn, "thumb-test")
            .unwrap()
            .expect("claimed thumb");
        (claimed, root.join(thumb))
    }

    fn setup_recovery_job(
        root: &Path,
        conn: &rusqlite::Connection,
        replacement_format: ImageFormat,
        replacement_dimensions: (u32, u32),
    ) -> (ClaimedJob, PathBuf, Vec<u8>) {
        let image_id = "image-recovery";
        let path = "recover.jpg";
        let source = root.join(path);
        fs::write(&source, b"old broken content").unwrap();
        let old_fingerprint = file_fingerprint(&source).unwrap();
        let thumb = format!(".imgindex/thumbs/{image_id}.jpg");
        upsert_sqlite_image(
            conn,
            &SqliteImageUpsert {
                id: Some(image_id.to_string()),
                root_path: root.to_string_lossy().to_string(),
                path: path.to_string(),
                thumb: thumb.clone(),
                size: old_fingerprint.size,
                mtime: old_fingerprint.mtime,
                width: 8,
                height: 6,
                ext: "jpg".to_string(),
            },
        )
        .unwrap();
        replace_sqlite_image_tags(conn, image_id, &["Favorite".to_string()], "user").unwrap();
        replace_sqlite_image_tags(conn, image_id, &["Folder".to_string()], "auto").unwrap();
        conn.execute("UPDATE images SET hidden = 1 WHERE id = ?1", [image_id])
            .unwrap();
        upsert_sqlite_file_issue(
            conn,
            &SqliteFileIssueUpsert {
                image_id: Some(image_id.to_string()),
                root_path: root.to_string_lossy().to_string(),
                path: path.to_string(),
                severity: FileIssueSeverity::Error,
                kind: FileIssueKind::DecodeError,
                expected_format: Some(SupportedImageFormat::Jpeg),
                detected_format: None,
                size: old_fingerprint.size,
                mtime_ns: old_fingerprint.mtime_ns,
                detail: Some("old decode failure".to_string()),
            },
        )
        .unwrap();
        let replacement = encoded_with_dimensions(
            replacement_format,
            replacement_dimensions.0,
            replacement_dimensions.1,
        );
        fs::write(&source, &replacement).unwrap();
        let target = root.join(&thumb);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"stale thumbnail").unwrap();
        let queued = enqueue_sqlite_job(
            conn,
            "thumb",
            json!({
                "image_id": image_id,
                "root_path": root,
                "path": path,
                "thumb": thumb,
                "mtime": old_fingerprint.mtime,
                "max_size": [640, 640],
            }),
            20,
            3,
            None,
        )
        .unwrap();
        let claimed = claim_next_sqlite_thumb_job(conn, "thumb-recovery")
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, queued.job.id);
        (claimed, target, replacement)
    }

    #[test]
    fn supported_and_mismatched_content_generate_thumbnails() {
        for (name, format, warning) in [
            ("valid.jpg", ImageFormat::Jpeg, false),
            ("valid.png", ImageFormat::Png, false),
            ("valid.webp", ImageFormat::WebP, false),
            ("png-as-jpeg.jpg", ImageFormat::Png, true),
            ("webp-as-jpeg.jpg", ImageFormat::WebP, true),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
            let (job, target) =
                setup_claimed_thumb(dir.path(), &conn, "image-1", name, &encoded(format));
            if warning {
                let fingerprint = file_fingerprint(&dir.path().join(name)).unwrap();
                upsert_sqlite_file_issue(
                    &conn,
                    &SqliteFileIssueUpsert {
                        image_id: Some("image-1".to_string()),
                        root_path: dir.path().to_string_lossy().to_string(),
                        path: name.to_string(),
                        severity: FileIssueSeverity::Warning,
                        kind: FileIssueKind::FormatMismatch,
                        expected_format: Some(SupportedImageFormat::Jpeg),
                        detected_format: Some(if format == ImageFormat::Png {
                            "png".to_string()
                        } else {
                            "webp".to_string()
                        }),
                        size: fingerprint.size,
                        mtime_ns: fingerprint.mtime_ns,
                        detail: Some("mismatch".to_string()),
                    },
                )
                .unwrap();
            }

            assert!(matches!(
                execute_thumb_job(&conn, &job, 120).unwrap(),
                ThumbExecution::Succeeded(_)
            ));
            assert!(target.exists(), "thumbnail missing for {name}");
            assert_eq!(
                get_sqlite_job(&conn, &job.id).unwrap().unwrap().state,
                "succeeded"
            );
            if warning {
                assert_eq!(
                    get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), name)
                        .unwrap()
                        .unwrap()
                        .severity,
                    FileIssueSeverity::Warning
                );
            }
        }
    }

    #[test]
    fn unsupported_content_is_terminal_and_creates_no_thumbnail() {
        for (name, contents) in [
            (
                "gif-as-jpeg.jpg",
                b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff".as_slice(),
            ),
            ("tiff-as-jpeg.jpg", b"II*\0\x08\0\0\0\0\0\0\0".as_slice()),
            (
                "bmp-as-jpeg.jpg",
                b"BM\x1a\0\0\0\0\0\0\0\x1a\0\0\0\x0c\0\0\0\x01\0\x01\0\x01\0\x18\0".as_slice(),
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
            let (job, target) = setup_claimed_thumb(dir.path(), &conn, "image-1", name, contents);

            assert!(matches!(
                execute_thumb_job(&conn, &job, 120).unwrap(),
                ThumbExecution::Failed { .. }
            ));
            assert!(!target.exists());
            assert_eq!(
                get_sqlite_job(&conn, &job.id).unwrap().unwrap().state,
                "failed"
            );
            assert_eq!(
                get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), name)
                    .unwrap()
                    .unwrap()
                    .kind,
                FileIssueKind::UnsupportedContent
            );
        }
    }

    #[test]
    fn header_valid_full_decode_failure_creates_terminal_decode_issue() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let contents = corrupt_png_pixels();
        let source = dir.path().join("corrupt.png");
        fs::write(&source, &contents).unwrap();
        assert!(inspect_supported_image(&source).is_ok());
        assert_eq!(
            decode_supported_image(&source).unwrap_err().kind,
            ImageInspectionErrorKind::DecodeError
        );
        fs::remove_file(&source).unwrap();
        let (job, target) =
            setup_claimed_thumb(dir.path(), &conn, "image-1", "corrupt.png", &contents);

        execute_thumb_job(&conn, &job, 120).unwrap();
        assert!(!target.exists());
        assert_eq!(
            get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), "corrupt.png")
                .unwrap()
                .unwrap()
                .kind,
            FileIssueKind::DecodeError
        );
    }

    #[test]
    fn changed_during_decode_is_retryable_without_file_issue() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let (job, _) = setup_claimed_thumb(
            dir.path(),
            &conn,
            "image-1",
            "changing.jpg",
            &encoded(ImageFormat::Jpeg),
        );
        let fingerprint = file_fingerprint(&dir.path().join("changing.jpg")).unwrap();
        let result = execute_thumb_job_with_decoder(&conn, &job, 120, |_| {
            Err(ImageInspectionError {
                kind: ImageInspectionErrorKind::ChangedDuringInspection,
                expected_format: Some(SupportedImageFormat::Jpeg),
                detected_format: Some("jpeg".to_string()),
                fingerprint: Some(FileFingerprint {
                    size: fingerprint.size + 1,
                    ..fingerprint
                }),
                detail: "changed while decoding".to_string(),
            })
        })
        .unwrap();
        assert!(matches!(result, ThumbExecution::Failed { .. }));
        assert_eq!(
            get_sqlite_job(&conn, &job.id).unwrap().unwrap().state,
            "queued"
        );
        assert!(
            get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), "changing.jpg")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn successful_matching_decode_recovers_stale_error_and_forces_fresh_thumbnail() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let (job, target, _) = setup_recovery_job(dir.path(), &conn, ImageFormat::Jpeg, (20, 5));

        assert!(matches!(
            execute_thumb_job(&conn, &job, 120).unwrap(),
            ThumbExecution::Succeeded(_)
        ));
        assert!(
            get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), "recover.jpg")
                .unwrap()
                .is_none()
        );
        let recovered = get_sqlite_image_by_id(&conn, "image-recovery")
            .unwrap()
            .unwrap();
        assert_eq!(recovered.id, "image-recovery");
        assert!(!recovered.hidden);
        assert_eq!((recovered.width, recovered.height), (20, 5));
        assert_eq!(
            list_sqlite_tags_for_image(&conn, "image-recovery").unwrap(),
            (vec!["Folder".to_string()], vec!["Favorite".to_string()])
        );
        assert_ne!(fs::read(&target).unwrap(), b"stale thumbnail");
        assert_eq!(
            get_sqlite_job(&conn, &job.id).unwrap().unwrap().state,
            "succeeded"
        );
    }

    #[test]
    fn successful_mismatched_decode_replaces_stale_error_with_warning() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let (job, target, _) = setup_recovery_job(dir.path(), &conn, ImageFormat::Png, (8, 6));

        assert!(matches!(
            execute_thumb_job(&conn, &job, 120).unwrap(),
            ThumbExecution::Succeeded(_)
        ));
        let issue = get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), "recover.jpg")
            .unwrap()
            .unwrap();
        assert_eq!(issue.severity, FileIssueSeverity::Warning);
        assert_eq!(issue.kind, FileIssueKind::FormatMismatch);
        assert_eq!(issue.detected_format.as_deref(), Some("png"));
        assert!(get_sqlite_image_by_id(&conn, "image-recovery")
            .unwrap()
            .is_some());
        assert_eq!(
            list_sqlite_tags_for_image(&conn, "image-recovery").unwrap(),
            (vec!["Folder".to_string()], vec!["Favorite".to_string()])
        );
        assert_ne!(fs::read(&target).unwrap(), b"stale thumbnail");
    }

    #[test]
    fn exhausted_stable_unreadable_becomes_terminal_file_issue() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let (job, target) = setup_claimed_thumb_with_attempts(
            dir.path(),
            &conn,
            "image-1",
            "unreadable.jpg",
            &encoded(ImageFormat::Jpeg),
            1,
        );
        let fingerprint = file_fingerprint(&dir.path().join("unreadable.jpg")).unwrap();

        let result = execute_thumb_job_with_decoder(&conn, &job, 120, |_| {
            Err(ImageInspectionError {
                kind: ImageInspectionErrorKind::Unreadable,
                expected_format: Some(SupportedImageFormat::Jpeg),
                detected_format: None,
                fingerprint: Some(fingerprint),
                detail: "stable permission failure".to_string(),
            })
        })
        .unwrap();
        assert!(matches!(result, ThumbExecution::Failed { .. }));
        assert!(!target.exists());
        assert_eq!(
            get_sqlite_job(&conn, &job.id).unwrap().unwrap().state,
            "failed"
        );
        assert_eq!(
            get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), "unreadable.jpg")
                .unwrap()
                .unwrap()
                .kind,
            FileIssueKind::Unreadable
        );
    }

    #[test]
    fn thumbnail_publish_failure_is_retryable_and_does_not_create_file_issue() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let (job, target) = setup_claimed_thumb(
            dir.path(),
            &conn,
            "image-1",
            "publish-failure.jpg",
            &encoded(ImageFormat::Jpeg),
        );
        let temp_target = thumb_attempt_temp_path(&target, &job);

        let outcome = execute_thumb_job_with_decoder_and_publisher(
            &conn,
            &job,
            120,
            decode_supported_image,
            |temp, _| {
                assert!(temp.exists());
                Err("injected publish failure".to_string())
            },
        )
        .expect("publish failure must not escape worker execution");

        assert!(matches!(outcome, ThumbExecution::Failed { .. }));
        assert_eq!(
            get_sqlite_job(&conn, &job.id).unwrap().unwrap().state,
            "queued"
        );
        assert!(!temp_target.exists());
        assert!(!target.exists());
        assert!(
            get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), "publish-failure.jpg")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn canceled_attempt_is_discarded_without_publishing_thumbnail_or_success_event() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let (job, target) = setup_claimed_thumb(
            dir.path(),
            &conn,
            "image-1",
            "canceled.jpg",
            &encoded(ImageFormat::Jpeg),
        );
        let temp_target = thumb_attempt_temp_path(&target, &job);
        assert!(cancel_sqlite_job(&conn, &job.id).unwrap());

        assert!(matches!(
            execute_thumb_job_with_decoder_and_publisher(
                &conn,
                &job,
                120,
                decode_supported_image,
                |_, _| Err("injected stale publish failure".to_string()),
            )
            .unwrap(),
            ThumbExecution::Discarded { .. }
        ));
        assert!(!temp_target.exists());
        assert!(!target.exists());
        assert_eq!(
            get_sqlite_job(&conn, &job.id).unwrap().unwrap().state,
            "canceled"
        );
        assert!(!list_sqlite_job_events(&conn, &job.id)
            .unwrap()
            .iter()
            .any(|event| event.event == "succeeded"));
        assert!(
            get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), "canceled.jpg")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn extensionless_legacy_job_is_terminal_without_sniffing_or_issue() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let path = "extensionless";
        fs::write(dir.path().join(path), encoded(ImageFormat::Jpeg)).unwrap();
        let job = enqueue_sqlite_job(
            &conn,
            "thumb",
            json!({
                "image_id": "image-1",
                "root_path": dir.path(),
                "path": path,
                "thumb": ".imgindex/thumbs/image-1.jpg",
                "mtime": 1,
                "max_size": [640, 640],
            }),
            10,
            3,
            None,
        )
        .unwrap();
        let claimed = claim_next_sqlite_thumb_job(&conn, "thumb-test")
            .unwrap()
            .unwrap();
        execute_thumb_job_with_decoder(&conn, &claimed, 120, |_| {
            panic!("extensionless job must not be content-sniffed")
        })
        .unwrap();
        assert_eq!(
            get_sqlite_job(&conn, &job.job.id).unwrap().unwrap().state,
            "failed"
        );
        assert!(
            get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), path)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn unchanged_known_error_skips_full_decode() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let path = "known.jpg";
        let contents = encoded(ImageFormat::Jpeg);
        let source = dir.path().join(path);
        fs::write(&source, &contents).unwrap();
        let fingerprint = file_fingerprint(&source).unwrap();
        upsert_sqlite_image(
            &conn,
            &SqliteImageUpsert {
                id: Some("image-1".to_string()),
                root_path: dir.path().to_string_lossy().to_string(),
                path: path.to_string(),
                thumb: ".imgindex/thumbs/image-1.jpg".to_string(),
                size: fingerprint.size,
                mtime: fingerprint.mtime,
                width: 8,
                height: 6,
                ext: "jpg".to_string(),
            },
        )
        .unwrap();
        upsert_sqlite_file_issue(
            &conn,
            &SqliteFileIssueUpsert {
                image_id: Some("image-1".to_string()),
                root_path: dir.path().to_string_lossy().to_string(),
                path: path.to_string(),
                severity: FileIssueSeverity::Error,
                kind: FileIssueKind::DecodeError,
                expected_format: Some(SupportedImageFormat::Jpeg),
                detected_format: Some("jpeg".to_string()),
                size: fingerprint.size,
                mtime_ns: fingerprint.mtime_ns,
                detail: Some("known decode error".to_string()),
            },
        )
        .unwrap();
        let queued = enqueue_sqlite_job(
            &conn,
            "thumb",
            json!({
                "image_id": "image-1",
                "root_path": dir.path(),
                "path": path,
                "thumb": ".imgindex/thumbs/image-1.jpg",
                "mtime": fingerprint.mtime,
                "max_size": [640, 640],
            }),
            10,
            3,
            None,
        )
        .unwrap();
        let claimed = claim_next_sqlite_thumb_job(&conn, "thumb-test")
            .unwrap()
            .unwrap();
        execute_thumb_job_with_decoder(&conn, &claimed, 120, |_| {
            panic!("unchanged known error must skip full decode")
        })
        .unwrap();
        assert_eq!(
            get_sqlite_job(&conn, &queued.job.id)
                .unwrap()
                .unwrap()
                .state,
            "failed"
        );
    }
}

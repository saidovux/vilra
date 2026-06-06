use image::codecs::jpeg::JpegEncoder;
use image::ColorType;
use serde_json::{json, Value};
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tagimage_core::{parse_u64_env, parse_usize_env, ThumbJobPayload};
use tagimage_db::sqlite::{
    claim_next_sqlite_thumb_job, mark_sqlite_thumb_failed, mark_sqlite_thumb_succeeded,
    open_sqlite_runtime_db, resolve_sqlite_runtime_path,
};
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

fn render_thumb(source: &Path, target: &Path, max_size: (u32, u32)) -> Result<(), String> {
    let dyn_img =
        image::open(source).map_err(|e| format!("open image {}: {e}", source.display()))?;
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

fn process_payload(
    payload: Value,
) -> Result<(PathBuf, PathBuf, i64, (u32, u32), Option<String>), String> {
    let parsed: ThumbJobPayload =
        serde_json::from_value(payload).map_err(|e| format!("invalid payload: {e}"))?;
    let source = Path::new(&parsed.root_path).join(&parsed.path);
    let target = Path::new(&parsed.root_path).join(&parsed.thumb);
    let source_mtime = parsed
        .mtime
        .or_else(|| file_mtime(&source))
        .ok_or_else(|| format!("cannot read source mtime: {}", source.display()))?;
    let max_size = parse_max_size(&parsed);
    Ok((source, target, source_mtime, max_size, parsed.image_id))
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
    let conn = open_sqlite_runtime_db(&db_path)
        .map_err(|e| format!("open sqlite db {} (slot={}): {e}", db_path.display(), slot))?;

    eprintln!(
        "[rust-thumb-worker] loop_started worker={} slot={}",
        worker_id, slot
    );

    loop {
        let claimed = claim_next_sqlite_thumb_job(&conn, &worker_id)?;
        let Some(job) = claimed else {
            {
                let mut worker_metrics = lock_worker_metrics(&shared_metrics);
                worker_metrics.maybe_log_summary(metrics_interval_sec, worker_count);
            }
            sleep(Duration::from_millis(poll_ms)).await;
            continue;
        };

        let job_started = Instant::now();

        let result = (|| -> Result<ThumbJobMetrics, String> {
            let (source, target, source_mtime, max_size, image_id) =
                process_payload(job.payload.clone())?;
            if !source.exists() {
                return Err(format!("source not found: {}", source.display()));
            }

            let ext = ext_lower(&source);
            let source_bytes = file_size(&source);
            let mut skipped_existing = false;
            let mut render_ms = 0_u128;

            if let Some(current_mtime) = file_mtime(&target) {
                if current_mtime >= source_mtime {
                    skipped_existing = true;
                }
            }

            if !skipped_existing {
                let render_started = Instant::now();
                render_thumb(&source, &target, max_size)?;
                render_ms = render_started.elapsed().as_millis();
            }

            let thumb_bytes = file_size(&target);
            let total_ms = job_started.elapsed().as_millis();

            Ok(ThumbJobMetrics {
                image_id,
                ext,
                total_ms,
                render_ms,
                source_bytes,
                thumb_bytes,
                skipped_existing,
            })
        })();

        match result {
            Ok(job_metrics) => {
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

                let success_metrics = json!({
                    "total_ms": job_metrics.total_ms.min(u64::MAX as u128) as u64,
                    "render_ms": job_metrics.render_ms.min(u64::MAX as u128) as u64,
                    "source_bytes": job_metrics.source_bytes,
                    "thumb_bytes": job_metrics.thumb_bytes,
                    "skipped_existing": job_metrics.skipped_existing,
                    "ext": &job_metrics.ext,
                });
                if let Err(e) = mark_sqlite_thumb_succeeded(&conn, &job.id, Some(success_metrics)) {
                    eprintln!(
                        "[rust-thumb-worker] mark success failed worker={} slot={} job={} error={}",
                        worker_id, slot, job.id, e
                    );
                }

                {
                    let mut worker_metrics = lock_worker_metrics(&shared_metrics);
                    worker_metrics.record_success(&job_metrics);
                    worker_metrics.maybe_log_summary(metrics_interval_sec, worker_count);
                }
            }
            Err(err) => {
                let total_ms = job_started.elapsed().as_millis();
                eprintln!(
                    "[rust-thumb-worker] job_failed worker={} slot={} job={} total_ms={} error={}",
                    worker_id, slot, job.id, total_ms, err
                );

                if let Err(e) =
                    mark_sqlite_thumb_failed(&conn, &job.id, &err, max_backoff_sec, Some(total_ms))
                {
                    eprintln!(
                        "[rust-thumb-worker] mark fail failed worker={} slot={} job={} error={}",
                        worker_id, slot, job.id, e
                    );
                }

                {
                    let mut worker_metrics = lock_worker_metrics(&shared_metrics);
                    worker_metrics.record_failure(total_ms);
                    worker_metrics.maybe_log_summary(metrics_interval_sec, worker_count);
                }
            }
        }
    }
}

async fn run() -> Result<(), String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir
        .parent()
        .and_then(|path| path.parent())
        .ok_or_else(|| "cannot resolve repo root".to_string())?
        .to_path_buf();
    let _ = dotenvy::from_path(repo_root.join(".env"));
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

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("[rust-thumb-worker] fatal: {e}");
        std::process::exit(1);
    }
}

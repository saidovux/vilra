use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tagimage_core::{
    expected_format_for_path, file_fingerprint, inspect_supported_image, parse_u64_env,
    FileIssueKind, FileIssueSeverity, ImageInspectionError, ImageInspectionErrorKind,
    MetadataJobPayload,
};
use tagimage_db::sqlite::{
    claim_next_sqlite_metadata_job, get_sqlite_file_issue_for_image,
    mark_sqlite_claimed_job_terminal_failed, mark_sqlite_image_job_terminal_failed,
    mark_sqlite_metadata_failed, mark_sqlite_metadata_succeeded, open_sqlite_runtime_db,
    record_sqlite_permanent_image_job_failure, resolve_sqlite_runtime_path,
    upsert_sqlite_file_issue, SqliteFileIssueUpsert,
};
use tagimage_db::ClaimedJob;
use tokio::time::sleep;

const METADATA_POLL_MS_DEFAULT: u64 = 750;
const METADATA_MAX_BACKOFF_SEC: i64 = 120;

#[derive(Debug)]
struct MetadataExtracted {
    payload: MetadataJobPayload,
    ext: String,
    source_bytes: u64,
    mtime: i64,
    width: u32,
    height: u32,
}

#[derive(Debug)]
struct WorkerMetrics {
    processed: u64,
    succeeded: u64,
    failed: u64,
    total_ms_sum: u128,
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
            total_ms_sum: 0,
            slowest_ms: 0,
            started_at: now,
            last_summary_at: now,
        }
    }

    fn record_success(&mut self, total_ms: u128) {
        self.processed += 1;
        self.succeeded += 1;
        self.total_ms_sum += total_ms;
        self.slowest_ms = self.slowest_ms.max(total_ms);
    }

    fn record_failure(&mut self, total_ms: u128) {
        self.processed += 1;
        self.failed += 1;
        self.total_ms_sum += total_ms;
        self.slowest_ms = self.slowest_ms.max(total_ms);
    }

    fn maybe_log_summary(&mut self, interval_sec: u64, worker_id: &str) {
        if interval_sec == 0 {
            return;
        }
        if self.last_summary_at.elapsed() < Duration::from_secs(interval_sec) {
            return;
        }
        self.last_summary_at = Instant::now();

        let avg_ms = if self.processed > 0 {
            (self.total_ms_sum / self.processed as u128) as u64
        } else {
            0
        };
        let elapsed_sec = self.started_at.elapsed().as_secs_f64();
        let jobs_per_sec = if elapsed_sec > 0.0 {
            self.succeeded as f64 / elapsed_sec
        } else {
            0.0
        };

        eprintln!(
            "[rust-metadata-worker] metrics worker={} processed={} succeeded={} failed={} avg_ms={} jobs_per_sec={:.2} slowest_ms={}",
            worker_id,
            self.processed,
            self.succeeded,
            self.failed,
            avg_ms,
            jobs_per_sec,
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

fn parse_poll_ms() -> u64 {
    let parsed = parse_u64_env("IMGVIEWER_METADATA_POLL_MS", METADATA_POLL_MS_DEFAULT);
    if parsed == 0 {
        METADATA_POLL_MS_DEFAULT
    } else {
        parsed
    }
}

fn env_bool(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

fn ext_lower(source: &Path) -> String {
    source
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

#[derive(Debug)]
enum MetadataExecution {
    Succeeded {
        extracted: MetadataExtracted,
        total_ms: u128,
    },
    Failed {
        error: String,
        total_ms: u128,
    },
}

fn execute_metadata_job(
    conn: &rusqlite::Connection,
    job: &ClaimedJob,
    authoritative: bool,
) -> Result<MetadataExecution, String> {
    execute_metadata_job_with_inspector(conn, job, authoritative, inspect_supported_image)
}

fn execute_metadata_job_with_inspector<F>(
    conn: &rusqlite::Connection,
    job: &ClaimedJob,
    authoritative: bool,
    inspector: F,
) -> Result<MetadataExecution, String>
where
    F: FnOnce(&Path) -> Result<tagimage_core::ImageInspection, ImageInspectionError>,
{
    let started = Instant::now();
    let parsed: MetadataJobPayload = match serde_json::from_value(job.payload.clone()) {
        Ok(parsed) => parsed,
        Err(error) => {
            let error = format!("invalid metadata payload: {error}");
            mark_sqlite_claimed_job_terminal_failed(
                conn,
                job,
                &error,
                Some(started.elapsed().as_millis()),
            )?;
            return Ok(MetadataExecution::Failed {
                error,
                total_ms: started.elapsed().as_millis(),
            });
        }
    };
    let source = PathBuf::from(&parsed.root_path).join(&parsed.path);
    if expected_format_for_path(&source).is_none() {
        let error = format!("unsupported image job path: {}", source.display());
        mark_sqlite_claimed_job_terminal_failed(
            conn,
            job,
            &error,
            Some(started.elapsed().as_millis()),
        )?;
        return Ok(MetadataExecution::Failed {
            error,
            total_ms: started.elapsed().as_millis(),
        });
    }

    let fingerprint = match file_fingerprint(&source) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            let total_ms = started.elapsed().as_millis();
            mark_sqlite_metadata_failed(
                conn,
                job,
                &error.detail,
                Some(total_ms),
                METADATA_MAX_BACKOFF_SEC,
            )?;
            return Ok(MetadataExecution::Failed {
                error: error.detail,
                total_ms,
            });
        }
    };
    let existing_issue =
        get_sqlite_file_issue_for_image(conn, &parsed.image_id, &parsed.root_path, &parsed.path)?;
    if let Some(issue) = &existing_issue {
        if issue.severity == FileIssueSeverity::Error
            && issue.size == fingerprint.size
            && issue.mtime_ns == fingerprint.mtime_ns
        {
            let error = format!("image unavailable: {}", issue.kind.as_str());
            let total_ms = started.elapsed().as_millis();
            mark_sqlite_image_job_terminal_failed(
                conn,
                job,
                &parsed.image_id,
                &error,
                Some(total_ms),
            )?;
            return Ok(MetadataExecution::Failed { error, total_ms });
        }
    }

    let inspection = match inspector(&source) {
        Ok(inspection) => inspection,
        Err(error) => {
            let total_ms = started.elapsed().as_millis();
            match error.kind {
                ImageInspectionErrorKind::DecodeError
                | ImageInspectionErrorKind::UnsupportedContent => {
                    let issue = permanent_issue_from_error(&parsed, &error)?;
                    record_sqlite_permanent_image_job_failure(
                        conn,
                        job,
                        &parsed.image_id,
                        &issue,
                        &error.detail,
                        Some(total_ms),
                    )?;
                }
                ImageInspectionErrorKind::UnsupportedPath => {
                    mark_sqlite_claimed_job_terminal_failed(
                        conn,
                        job,
                        &error.detail,
                        Some(total_ms),
                    )?;
                }
                ImageInspectionErrorKind::ChangedDuringInspection
                | ImageInspectionErrorKind::Unreadable => {
                    mark_sqlite_metadata_failed(
                        conn,
                        job,
                        &error.detail,
                        Some(total_ms),
                        METADATA_MAX_BACKOFF_SEC,
                    )?;
                }
            }
            return Ok(MetadataExecution::Failed {
                error: error.detail,
                total_ms,
            });
        }
    };

    if inspection.is_format_mismatch()
        && !existing_issue
            .as_ref()
            .is_some_and(|issue| issue.severity == FileIssueSeverity::Error)
    {
        upsert_sqlite_file_issue(
            conn,
            &SqliteFileIssueUpsert {
                image_id: Some(parsed.image_id.clone()),
                root_path: parsed.root_path.clone(),
                path: parsed.path.clone(),
                severity: FileIssueSeverity::Warning,
                kind: FileIssueKind::FormatMismatch,
                expected_format: Some(inspection.expected_format),
                detected_format: Some(inspection.detected_format.as_str().to_string()),
                size: inspection.fingerprint.size,
                mtime_ns: inspection.fingerprint.mtime_ns,
                detail: Some(format!(
                    "expected {} from extension, detected {} from content",
                    inspection.expected_format.as_str(),
                    inspection.detected_format.as_str()
                )),
            },
        )?;
    }

    let extracted = MetadataExtracted {
        payload: parsed,
        ext: ext_lower(&source),
        source_bytes: inspection.fingerprint.size.max(0) as u64,
        mtime: inspection.fingerprint.mtime,
        width: inspection.width,
        height: inspection.height,
    };
    let metadata_json = json!({
        "image_id": &extracted.payload.image_id,
        "root_path": &extracted.payload.root_path,
        "path": &extracted.payload.path,
        "ext": &extracted.ext,
        "source_bytes": extracted.source_bytes,
        "mtime": extracted.mtime,
        "width": extracted.width,
        "height": extracted.height,
    });
    mark_sqlite_metadata_succeeded(conn, job, metadata_json, authoritative)?;
    Ok(MetadataExecution::Succeeded {
        extracted,
        total_ms: started.elapsed().as_millis(),
    })
}

fn permanent_issue_from_error(
    payload: &MetadataJobPayload,
    error: &ImageInspectionError,
) -> Result<SqliteFileIssueUpsert, String> {
    let kind = error
        .file_issue_kind()
        .ok_or_else(|| format!("non-permanent image error: {}", error.detail))?;
    let fingerprint = error
        .fingerprint
        .ok_or_else(|| format!("permanent image error has no fingerprint: {}", error.detail))?;
    Ok(SqliteFileIssueUpsert {
        image_id: Some(payload.image_id.clone()),
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
    poll_ms: u64,
    metrics_interval_sec: u64,
    slow_ms: u128,
    authoritative: bool,
) -> Result<(), String> {
    let conn = open_sqlite_runtime_db(&db_path)
        .map_err(|e| format!("open sqlite db {}: {e}", db_path.display()))?;

    let mut metrics = WorkerMetrics::new();

    loop {
        let claimed = claim_next_sqlite_metadata_job(&conn, &worker_id)?;
        let Some(job) = claimed else {
            metrics.maybe_log_summary(metrics_interval_sec, &worker_id);
            sleep(Duration::from_millis(poll_ms)).await;
            continue;
        };

        match execute_metadata_job(&conn, &job, authoritative)? {
            MetadataExecution::Succeeded {
                extracted,
                total_ms,
            } => {
                eprintln!(
                    "[rust-metadata-worker] job_done worker={} job={} image={} ext={} total_ms={} width={} height={}",
                    worker_id,
                    job.id,
                    extracted.payload.image_id,
                    extracted.ext,
                    total_ms,
                    extracted.width,
                    extracted.height
                );

                if total_ms >= slow_ms {
                    eprintln!(
                        "[rust-metadata-worker] slow_job worker={} job={} image={} ext={} total_ms={} width={} height={}",
                        worker_id,
                        job.id,
                        extracted.payload.image_id,
                        extracted.ext,
                        total_ms,
                        extracted.width,
                        extracted.height
                    );
                }

                metrics.record_success(total_ms);
                metrics.maybe_log_summary(metrics_interval_sec, &worker_id);
            }
            MetadataExecution::Failed { error, total_ms } => {
                eprintln!(
                    "[rust-metadata-worker] job_failed worker={} job={} total_ms={} error={}",
                    worker_id, job.id, total_ms, error
                );
                metrics.record_failure(total_ms);
                metrics.maybe_log_summary(metrics_interval_sec, &worker_id);
            }
        }
    }
}

async fn run() -> Result<(), String> {
    let repo_root = resolve_repo_root()?;
    if !env_bool("TAGIMAGE_PACKAGED_RUNTIME", false) {
        let _ = dotenvy::from_path(repo_root.join(".env"));
    }
    let db_path = resolve_sqlite_runtime_path(&repo_root);
    let worker_id = format!("rust-metadata-{}", now_unix());
    let poll_ms = parse_poll_ms();
    let slow_ms = parse_u64_env("IMGVIEWER_METADATA_SLOW_MS", 1000) as u128;
    let metrics_interval_sec = parse_u64_env("IMGVIEWER_METADATA_METRICS_INTERVAL_SEC", 30);
    let authoritative = env_bool("IMGVIEWER_METADATA_AUTHORITATIVE", false);

    eprintln!(
        "[rust-metadata-worker] started as {} mode={} sqlite={}",
        worker_id,
        if authoritative {
            "authoritative"
        } else {
            "shadow"
        },
        db_path.display()
    );

    run_worker_loop(
        db_path,
        worker_id,
        poll_ms,
        metrics_interval_sec,
        slow_ms,
        authoritative,
    )
    .await
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
        eprintln!("[rust-metadata-worker] fatal: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
    use std::fs;
    use std::io::Cursor;
    use tagimage_core::{file_fingerprint, FileIssueKind, SupportedImageFormat};
    use tagimage_db::sqlite::{
        enqueue_sqlite_job, enqueue_sqlite_metadata_job, get_sqlite_file_issue, get_sqlite_job,
        init_sqlite_db, upsert_sqlite_file_issue, upsert_sqlite_image, SqliteImageUpsert,
    };

    fn encoded(format: ImageFormat) -> Vec<u8> {
        let image = DynamicImage::ImageRgb8(RgbImage::from_pixel(7, 5, Rgb([12, 34, 56])));
        let mut bytes = Cursor::new(Vec::new());
        image.write_to(&mut bytes, format).unwrap();
        bytes.into_inner()
    }

    fn insert_image_and_claim(
        conn: &rusqlite::Connection,
        root: &Path,
        path: &str,
        contents: &[u8],
    ) -> ClaimedJob {
        fs::write(root.join(path), contents).unwrap();
        let fingerprint = file_fingerprint(&root.join(path)).unwrap();
        upsert_sqlite_image(
            conn,
            &SqliteImageUpsert {
                id: Some("image-1".to_string()),
                root_path: root.to_string_lossy().to_string(),
                path: path.to_string(),
                thumb: ".imgindex/thumbs/image-1.jpg".to_string(),
                size: fingerprint.size,
                mtime: fingerprint.mtime,
                width: 7,
                height: 5,
                ext: ext_lower(&root.join(path)),
            },
        )
        .unwrap();
        enqueue_sqlite_metadata_job(
            conn,
            "image-1",
            &root.to_string_lossy(),
            path,
            Some(fingerprint.mtime),
            10,
            3,
        )
        .unwrap();
        claim_next_sqlite_metadata_job(conn, "metadata-test")
            .unwrap()
            .unwrap()
    }

    #[test]
    fn metadata_uses_shared_content_inspection_and_records_mismatch_warning() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let job = insert_image_and_claim(
            &conn,
            dir.path(),
            "png-as-jpeg.jpg",
            &encoded(ImageFormat::Png),
        );

        let result = execute_metadata_job(&conn, &job, true).unwrap();
        let MetadataExecution::Succeeded { extracted, .. } = result else {
            panic!("metadata should succeed");
        };
        assert_eq!((extracted.width, extracted.height), (7, 5));
        let issue = get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), "png-as-jpeg.jpg")
            .unwrap()
            .unwrap();
        assert_eq!(issue.severity, FileIssueSeverity::Warning);
        assert_eq!(issue.kind, FileIssueKind::FormatMismatch);
        assert_eq!(issue.detected_format.as_deref(), Some("png"));
        assert_eq!(
            get_sqlite_job(&conn, &job.id).unwrap().unwrap().state,
            "succeeded"
        );
    }

    #[test]
    fn unchanged_error_issue_skips_metadata_inspection() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let path = "known.jpg";
        let source = dir.path().join(path);
        fs::write(&source, encoded(ImageFormat::Jpeg)).unwrap();
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
                width: 7,
                height: 5,
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
                detail: Some("known full decode error".to_string()),
            },
        )
        .unwrap();
        let queued = enqueue_sqlite_job(
            &conn,
            "metadata",
            json!({
                "image_id": "image-1",
                "root_path": dir.path(),
                "path": path,
            }),
            10,
            3,
            None,
        )
        .unwrap();
        let claimed = claim_next_sqlite_metadata_job(&conn, "metadata-test")
            .unwrap()
            .unwrap();

        execute_metadata_job_with_inspector(&conn, &claimed, true, |_| {
            panic!("unchanged error must skip header inspection")
        })
        .unwrap();
        assert_eq!(
            get_sqlite_job(&conn, &queued.job.id)
                .unwrap()
                .unwrap()
                .state,
            "failed"
        );
        assert_eq!(
            get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), path)
                .unwrap()
                .unwrap()
                .detail
                .as_deref(),
            Some("known full decode error")
        );
    }

    #[test]
    fn metadata_permanent_header_error_creates_terminal_issue() {
        let dir = tempfile::tempdir().unwrap();
        let conn = init_sqlite_db(&dir.path().join("db.sqlite")).unwrap();
        let job = insert_image_and_claim(
            &conn,
            dir.path(),
            "gif-as-jpeg.jpg",
            b"GIF89a\x01\0\x01\0\x80\0\0\0\0\0\xff\xff\xff",
        );

        assert!(matches!(
            execute_metadata_job(&conn, &job, true).unwrap(),
            MetadataExecution::Failed { .. }
        ));
        assert_eq!(
            get_sqlite_job(&conn, &job.id).unwrap().unwrap().state,
            "failed"
        );
        assert_eq!(
            get_sqlite_file_issue(&conn, &dir.path().to_string_lossy(), "gif-as-jpeg.jpg")
                .unwrap()
                .unwrap()
                .kind,
            FileIssueKind::UnsupportedContent
        );
    }
}

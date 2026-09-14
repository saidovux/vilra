use image::image_dimensions;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tagimage_core::{parse_u64_env, MetadataJobPayload};
use tagimage_db::sqlite::{
    claim_next_sqlite_metadata_job, mark_sqlite_metadata_failed, mark_sqlite_metadata_succeeded,
    open_sqlite_runtime_db, resolve_sqlite_runtime_path,
};
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

fn source_metadata(source: &Path) -> Result<(u64, i64), String> {
    let meta =
        fs::metadata(source).map_err(|e| format!("read metadata {}: {e}", source.display()))?;
    let source_bytes = meta.len();
    let modified = meta
        .modified()
        .map_err(|e| format!("read mtime {}: {e}", source.display()))?;
    let mtime = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("mtime before unix epoch {}: {e}", source.display()))?
        .as_secs() as i64;
    Ok((source_bytes, mtime))
}

fn extract_metadata(payload: Value) -> Result<MetadataExtracted, String> {
    let parsed: MetadataJobPayload =
        serde_json::from_value(payload).map_err(|e| format!("invalid metadata payload: {e}"))?;

    let source = PathBuf::from(&parsed.root_path).join(&parsed.path);
    if !source.exists() {
        return Err(format!("source not found: {}", source.display()));
    }

    let ext = ext_lower(&source);
    let (source_bytes, mtime) = source_metadata(&source)?;
    let (width, height) = image_dimensions(&source)
        .map_err(|e| format!("image dimensions {}: {e}", source.display()))?;

    Ok(MetadataExtracted {
        payload: parsed,
        ext,
        source_bytes,
        mtime,
        width,
        height,
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

        let started_at = Instant::now();

        match extract_metadata(job.payload.clone()) {
            Ok(extracted) => {
                let total_ms = started_at.elapsed().as_millis();
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

                if let Err(e) =
                    mark_sqlite_metadata_succeeded(&conn, &job, metadata_json, authoritative)
                {
                    eprintln!(
                        "[rust-metadata-worker] mark success failed worker={} job={} error={}",
                        worker_id, job.id, e
                    );
                }

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
            Err(err) => {
                let total_ms = started_at.elapsed().as_millis();
                eprintln!(
                    "[rust-metadata-worker] job_failed worker={} job={} total_ms={} error={}",
                    worker_id, job.id, total_ms, err
                );

                if let Err(e) = mark_sqlite_metadata_failed(
                    &conn,
                    &job,
                    &err,
                    Some(total_ms),
                    METADATA_MAX_BACKOFF_SEC,
                ) {
                    eprintln!(
                        "[rust-metadata-worker] mark fail failed worker={} job={} error={}",
                        worker_id, job.id, e
                    );
                }

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

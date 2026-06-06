use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub sqlite_path: PathBuf,
    pub host: String,
    pub port: u16,
    pub repo_root: PathBuf,
    pub thumb_job_mode: String,
    pub thumb_wait_ms: u64,
    pub thumb_poll_ms: u64,
    pub thumb_sync_fallback: bool,
    pub thumb_worker_expected: bool,
    pub rescan_worker_expected: bool,
    pub inline_worker: bool,
    pub rust_scanner: bool,
    pub metadata_worker: bool,
    pub metadata_authoritative: bool,
    pub thumb_max_attempts: i32,
    pub rescan_max_attempts: i32,
    pub job_stale_running_sec: i64,
}

impl AppConfig {
    pub fn from_env_and_args() -> Result<Self, String> {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = manifest_dir
            .parent()
            .and_then(|path| path.parent())
            .ok_or_else(|| "cannot resolve repo root".to_string())?
            .to_path_buf();
        let _ = dotenvy::from_path(repo_root.join(".env"));

        let mut host =
            std::env::var("IMGVIEWER_RUST_API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let mut port = env_u16("IMGVIEWER_RUST_API_PORT", 8010);
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--host" => {
                    i += 1;
                    host = args
                        .get(i)
                        .ok_or_else(|| "missing value for --host".to_string())?
                        .clone();
                }
                "--port" | "-p" => {
                    i += 1;
                    let raw = args
                        .get(i)
                        .ok_or_else(|| "missing value for --port".to_string())?;
                    port = raw
                        .parse::<u16>()
                        .map_err(|e| format!("invalid port {raw}: {e}"))?;
                }
                "--help" | "-h" => {
                    println!("Usage: imgviewer-api-server [--host 127.0.0.1] [--port 8010]");
                    std::process::exit(0);
                }
                other => return Err(format!("unexpected argument: {other}")),
            }
            i += 1;
        }

        let legacy_python = env_bool("IMGVIEWER_LEGACY_PYTHON", false);
        let thumb_job_mode = std::env::var("IMGVIEWER_THUMB_JOB_MODE")
            .unwrap_or_else(|_| {
                if legacy_python {
                    "sync".to_string()
                } else {
                    "queue".to_string()
                }
            })
            .trim()
            .to_ascii_lowercase();
        let thumb_worker_expected =
            env_bool("IMGVIEWER_THUMB_WORKER_EXPECTED", thumb_job_mode == "queue");
        let metadata_worker = env_bool("IMGVIEWER_METADATA_WORKER", !legacy_python);
        let metadata_authoritative =
            metadata_worker && env_bool("IMGVIEWER_METADATA_AUTHORITATIVE", !legacy_python);
        let sqlite_path = tagimage_db::sqlite::resolve_sqlite_runtime_path(&repo_root);

        Ok(Self {
            sqlite_path,
            host,
            port,
            repo_root,
            thumb_job_mode,
            thumb_wait_ms: env_u64("IMGVIEWER_THUMB_WAIT_MS", 1200),
            thumb_poll_ms: env_u64("IMGVIEWER_THUMB_POLL_MS", 120).max(10),
            thumb_sync_fallback: env_bool("IMGVIEWER_THUMB_SYNC_FALLBACK", false),
            thumb_worker_expected,
            rescan_worker_expected: env_bool("IMGVIEWER_RESCAN_WORKER_EXPECTED", true),
            inline_worker: env_bool("IMGVIEWER_INLINE_WORKER", legacy_python),
            rust_scanner: env_bool("IMGVIEWER_RUST_SCANNER", !legacy_python),
            metadata_worker,
            metadata_authoritative,
            thumb_max_attempts: env_i32("IMGVIEWER_THUMB_MAX_ATTEMPTS", 5).max(1),
            rescan_max_attempts: env_i32("IMGVIEWER_RESCAN_MAX_ATTEMPTS", 3).max(1),
            job_stale_running_sec: env_i64("IMGVIEWER_JOB_STALE_RUNNING_SEC", 300).max(0),
        })
    }
}

pub fn env_bool(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no"
        ),
        Err(_) => default,
    }
}

fn env_u16(name: &str, default: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

fn env_i32(name: &str, default: i32) -> i32 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<i32>().ok())
        .unwrap_or(default)
}

fn env_i64(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

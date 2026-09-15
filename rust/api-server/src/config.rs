use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AppConfig {
    pub sqlite_path: PathBuf,
    pub init_db_only: bool,
    pub host: String,
    pub port: u16,
    pub repo_root: PathBuf,
    pub static_dir: PathBuf,
    pub thumb_job_mode: String,
    pub thumb_wait_ms: u64,
    pub thumb_poll_ms: u64,
    pub thumb_sync_fallback: bool,
    pub thumb_worker_expected: bool,
    pub metadata_worker: bool,
    pub metadata_authoritative: bool,
    pub thumb_max_attempts: i32,
    pub job_stale_running_sec: i64,
}

impl AppConfig {
    pub fn from_env_and_args() -> Result<Self, String> {
        let repo_root = resolve_repo_root()?;
        if !env_bool("TAGIMAGE_PACKAGED_RUNTIME", false) {
            let _ = dotenvy::from_path(repo_root.join(".env"));
        }

        let mut host =
            std::env::var("IMGVIEWER_RUST_API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let mut port = env_u16("IMGVIEWER_RUST_API_PORT", 8010);
        let mut init_db_only = false;
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
                "--init-db" => init_db_only = true,
                "--help" | "-h" => {
                    println!(
                        "Usage: imgviewer-api-server [--host 127.0.0.1] [--port 8010] [--init-db]"
                    );
                    std::process::exit(0);
                }
                other => return Err(format!("unexpected argument: {other}")),
            }
            i += 1;
        }

        let sqlite_path = tagimage_db::sqlite::resolve_sqlite_runtime_path(&repo_root);
        let static_dir = resolve_static_dir(&repo_root);
        let metadata_worker = env_bool("IMGVIEWER_METADATA_WORKER", true);

        Ok(Self {
            sqlite_path,
            init_db_only,
            host,
            port,
            repo_root,
            static_dir,
            thumb_job_mode: "queue".to_string(),
            thumb_wait_ms: env_u64("IMGVIEWER_THUMB_WAIT_MS", 1200),
            thumb_poll_ms: env_u64("IMGVIEWER_THUMB_POLL_MS", 120).max(10),
            thumb_sync_fallback: false,
            thumb_worker_expected: env_bool("IMGVIEWER_THUMB_WORKER_EXPECTED", true),
            metadata_worker,
            metadata_authoritative: metadata_worker
                && env_bool("IMGVIEWER_METADATA_AUTHORITATIVE", true),
            thumb_max_attempts: env_i32("IMGVIEWER_THUMB_MAX_ATTEMPTS", 5).max(1),
            job_stale_running_sec: env_i64("IMGVIEWER_JOB_STALE_RUNNING_SEC", 300).max(0),
        })
    }
}

fn resolve_static_dir(repo_root: &Path) -> PathBuf {
    let path = std::env::var_os("TAGIMAGE_STATIC_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("static"));
    if path.is_absolute() {
        path
    } else {
        repo_root.join(path)
    }
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

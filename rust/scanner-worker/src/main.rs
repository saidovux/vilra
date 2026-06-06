use image::image_dimensions;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tagimage_core::{parse_u64_env, RescanJobPayload, ScannerShadowJobPayload};
use tagimage_db::sqlite::{
    claim_next_sqlite_rescan_job, claim_next_sqlite_scanner_shadow_job,
    cleanup_sqlite_hidden_image_tag_data, clear_sqlite_auto_tags_for_image,
    enqueue_sqlite_thumb_job, list_sqlite_existing_image_ids_for_root,
    list_sqlite_existing_images_for_root, mark_sqlite_images_hidden_for_root,
    mark_sqlite_rescan_failed, mark_sqlite_rescan_succeeded, mark_sqlite_scanner_shadow_failed,
    mark_sqlite_scanner_shadow_succeeded, open_sqlite_runtime_db, resolve_sqlite_runtime_path,
    touch_sqlite_job_progress, upsert_sqlite_image, SqliteImageUpsert,
};
use tokio::time::sleep;
use uuid::Uuid;

const INDEX_DIR_NAME: &str = ".imgindex";
const THUMBS_DIR_NAME: &str = "thumbs";
const SCANNER_POLL_MS_DEFAULT: u64 = 750;
const SCANNER_MAX_BACKOFF_SEC: i64 = 120;
const THUMB_PRIORITY: i32 = 20;

#[derive(Debug, Clone)]
struct ExistingImage {
    id: String,
    path: String,
    hidden: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerMode {
    Shadow,
    Authoritative,
}

#[derive(Debug, Clone)]
struct ScannedImage {
    rel: String,
    ext: String,
    source_bytes: i64,
    mtime: i64,
    width: i32,
    height: i32,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn env_bool(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "y" | "on")
        }
        Err(_) => default,
    }
}

fn parse_poll_ms() -> u64 {
    let parsed = parse_u64_env("IMGVIEWER_SCANNER_POLL_MS", SCANNER_POLL_MS_DEFAULT);
    if parsed == 0 {
        SCANNER_POLL_MS_DEFAULT
    } else {
        parsed
    }
}

fn parse_i32_env(name: &str, default: i32, min_value: i32) -> i32 {
    let parsed = std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<i32>().ok())
        .unwrap_or(default);
    parsed.max(min_value)
}

fn worker_mode() -> WorkerMode {
    if env_bool("IMGVIEWER_RUST_SCANNER", false) {
        WorkerMode::Authoritative
    } else {
        WorkerMode::Shadow
    }
}

fn thumb_queue_enabled() -> bool {
    std::env::var("IMGVIEWER_THUMB_JOB_MODE")
        .unwrap_or_else(|_| "sync".to_string())
        .trim()
        .eq_ignore_ascii_case("queue")
}

fn uuid_hex() -> String {
    Uuid::new_v4().simple().to_string()
}

fn new_image_id() -> String {
    uuid_hex().chars().take(12).collect()
}

fn supported_ext(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "webp")
    )
}

fn ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn path_to_rel(root: &Path, path: &Path) -> Result<String, String> {
    path.strip_prefix(root)
        .map_err(|e| format!("strip root {} from {}: {e}", root.display(), path.display()))
        .map(|value| value.to_string_lossy().to_string())
}

fn sort_like_python_scan(root: &Path, paths: &mut [PathBuf]) {
    paths.sort_by(|left, right| {
        let left_key = path_to_rel(root, left).unwrap_or_default().to_lowercase();
        let right_key = path_to_rel(root, right).unwrap_or_default().to_lowercase();
        left_key.cmp(&right_key)
    });
}

fn sort_rel_paths(paths: &mut [String]) {
    paths.sort_by(|left, right| {
        left.to_lowercase()
            .cmp(&right.to_lowercase())
            .then_with(|| left.cmp(right))
    });
}

fn scan_dir(current: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries =
        fs::read_dir(current).map_err(|e| format!("read dir {}: {e}", current.display()))?;

    for entry_result in entries {
        let entry =
            entry_result.map_err(|e| format!("read dir entry {}: {e}", current.display()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| format!("read file type {}: {e}", path.display()))?;

        if file_type.is_dir() {
            if entry.file_name().to_string_lossy() == INDEX_DIR_NAME {
                continue;
            }
            scan_dir(&path, out)?;
        } else if file_type.is_file() && supported_ext(&path) {
            out.push(path);
        }
    }

    Ok(())
}

fn scan_image_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    if !root.is_dir() {
        return Err(format!("root is not a directory: {}", root.display()));
    }
    let mut images = Vec::new();
    scan_dir(root, &mut images)?;
    sort_like_python_scan(root, &mut images);
    Ok(images)
}

fn file_mtime(meta: &fs::Metadata, path: &Path) -> Result<i64, String> {
    let modified = meta
        .modified()
        .map_err(|e| format!("read mtime {}: {e}", path.display()))?;
    modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("mtime before unix epoch {}: {e}", path.display()))
        .map(|duration| duration.as_secs() as i64)
}

fn thumb_rel_for(existing_id: &str) -> String {
    format!("{INDEX_DIR_NAME}/{THUMBS_DIR_NAME}/{existing_id}.jpg")
}

fn should_regenerate_thumb(src_mtime: i64, thumb_path: &Path) -> bool {
    let Ok(meta) = fs::metadata(thumb_path) else {
        return true;
    };
    let Ok(thumb_mtime) = file_mtime(&meta, thumb_path) else {
        return true;
    };
    thumb_mtime < src_mtime
}

fn le_u16(bytes: &[u8]) -> Option<u16> {
    if bytes.len() < 2 {
        return None;
    }
    Some(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn le_u24(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 3 {
        return None;
    }
    Some(u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16))
}

fn le_u32(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 4 {
        return None;
    }
    Some(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }

    let mut offset = 12usize;
    while offset + 8 <= bytes.len() {
        let fourcc = &bytes[offset..offset + 4];
        let chunk_size = le_u32(&bytes[offset + 4..offset + 8])? as usize;
        let data_start = offset + 8;
        let data_end = data_start.checked_add(chunk_size)?;
        if data_end > bytes.len() {
            return None;
        }
        let data = &bytes[data_start..data_end];

        match fourcc {
            b"VP8X" if data.len() >= 10 => {
                let width = le_u24(&data[4..7])? + 1;
                let height = le_u24(&data[7..10])? + 1;
                return Some((width, height));
            }
            b"VP8L" if data.len() >= 5 && data[0] == 0x2f => {
                let packed = le_u32(&data[1..5])?;
                let width = (packed & 0x3fff) + 1;
                let height = ((packed >> 14) & 0x3fff) + 1;
                return Some((width, height));
            }
            b"VP8 " if data.len() >= 10 && data[3..6] == [0x9d, 0x01, 0x2a] => {
                let width = u32::from(le_u16(&data[6..8])? & 0x3fff);
                let height = u32::from(le_u16(&data[8..10])? & 0x3fff);
                return Some((width, height));
            }
            _ => {}
        }

        offset = data_end + (chunk_size % 2);
    }

    None
}

fn image_dimensions_like_python(path: &Path) -> (u32, u32) {
    if let Ok(dimensions) = image_dimensions(path) {
        return dimensions;
    }

    fs::read(path)
        .ok()
        .and_then(|bytes| webp_dimensions(&bytes))
        .unwrap_or((0, 0))
}

fn build_scanned_image(root: &Path, image_path: &Path) -> Result<ScannedImage, String> {
    let rel = path_to_rel(root, image_path)?;
    let meta = fs::metadata(image_path)
        .map_err(|e| format!("read metadata {}: {e}", image_path.display()))?;
    let (width, height) = image_dimensions_like_python(image_path);
    Ok(ScannedImage {
        rel,
        ext: ext_lower(image_path),
        source_bytes: meta.len().min(i64::MAX as u64) as i64,
        mtime: file_mtime(&meta, image_path)?,
        width: width.min(i32::MAX as u32) as i32,
        height: height.min(i32::MAX as u32) as i32,
    })
}

fn load_existing_images(
    conn: &Connection,
    root_path: &str,
) -> Result<HashMap<String, ExistingImage>, String> {
    let rows = list_sqlite_existing_images_for_root(conn, root_path)?;
    let mut out = HashMap::new();
    for row in rows {
        let path = row.path;
        out.insert(
            path.clone(),
            ExistingImage {
                id: row.id,
                path,
                hidden: row.hidden,
            },
        );
    }
    Ok(out)
}

fn load_existing_image_ids(
    conn: &Connection,
    root_path: &str,
) -> Result<HashMap<String, String>, String> {
    list_sqlite_existing_image_ids_for_root(conn, root_path)
}

fn mark_images_hidden_for_root(conn: &Connection, root_path: &str) -> Result<(), String> {
    mark_sqlite_images_hidden_for_root(conn, root_path)?;
    Ok(())
}

fn upsert_image_row(
    conn: &Connection,
    root_path: &str,
    image: &ScannedImage,
    image_id: &str,
    thumb_rel: &str,
) -> Result<String, String> {
    upsert_sqlite_image(
        conn,
        &SqliteImageUpsert {
            id: Some(image_id.to_string()),
            root_path: root_path.to_string(),
            path: image.rel.clone(),
            thumb: thumb_rel.to_string(),
            size: image.source_bytes,
            mtime: image.mtime,
            width: image.width,
            height: image.height,
            ext: image.ext.clone(),
        },
    )
}

fn clear_auto_tags_for_image(conn: &Connection, image_id: &str) -> Result<(), String> {
    clear_sqlite_auto_tags_for_image(conn, image_id)?;
    Ok(())
}

fn cleanup_hidden_image_tag_data(conn: &Connection) -> Result<(), String> {
    cleanup_sqlite_hidden_image_tag_data(conn)
}

fn enqueue_thumb_job(
    conn: &Connection,
    image_id: &str,
    root_path: &str,
    image: &ScannedImage,
    thumb_rel: &str,
) -> Result<bool, String> {
    let max_attempts = parse_i32_env("IMGVIEWER_THUMB_MAX_ATTEMPTS", 5, 1);
    let (_, deduped) = enqueue_sqlite_thumb_job(
        conn,
        image_id,
        root_path,
        &image.rel,
        thumb_rel,
        image.mtime,
        THUMB_PRIORITY,
        max_attempts,
    )?;
    Ok(!deduped)
}

fn process_authoritative_image(
    conn: &Connection,
    root: &Path,
    root_path: &str,
    image: &ScannedImage,
    existing_by_rel: &HashMap<String, String>,
    queue_thumbs: bool,
) -> Result<(), String> {
    let image_id = existing_by_rel
        .get(&image.rel)
        .cloned()
        .unwrap_or_else(new_image_id);
    let thumb_rel = thumb_rel_for(&image_id);
    let db_image_id = upsert_image_row(conn, root_path, image, &image_id, &thumb_rel)?;
    clear_auto_tags_for_image(conn, &db_image_id)?;

    if queue_thumbs && should_regenerate_thumb(image.mtime, &root.join(&thumb_rel)) {
        enqueue_thumb_job(conn, &db_image_id, root_path, image, &thumb_rel)?;
    }

    Ok(())
}

fn build_shadow_scan(conn: &Connection, payload: Value) -> Result<(Value, i32), String> {
    let parsed: ScannerShadowJobPayload =
        serde_json::from_value(payload).map_err(|e| format!("invalid scanner payload: {e}"))?;
    let root = PathBuf::from(&parsed.root_path);
    let started = Instant::now();
    let existing_by_path = load_existing_images(conn, &parsed.root_path)?;
    let image_paths = scan_image_paths(&root)?;

    let mut scanned_paths = HashSet::new();
    let mut paths = Vec::new();
    let mut images = Vec::new();
    let mut thumb_job_candidates = Vec::new();

    for image_path in image_paths {
        let image = build_scanned_image(&root, &image_path)?;
        let existing = existing_by_path.get(&image.rel);
        let existing_id = existing.map(|item| item.id.clone());
        let thumb_rel = existing_id.as_deref().map(thumb_rel_for);
        let thumb_job_candidate = if let Some(thumb) = thumb_rel.as_deref() {
            should_regenerate_thumb(image.mtime, &root.join(thumb))
        } else {
            true
        };

        if thumb_job_candidate {
            thumb_job_candidates.push(image.rel.clone());
        }
        scanned_paths.insert(image.rel.clone());
        paths.push(image.rel.clone());
        images.push(json!({
            "path": image.rel,
            "ext": image.ext,
            "source_bytes": image.source_bytes,
            "mtime": image.mtime,
            "width": image.width,
            "height": image.height,
            "existing_id": existing_id,
            "is_new": existing.is_none(),
            "thumb": thumb_rel,
            "thumb_job_candidate": thumb_job_candidate,
        }));
    }

    let mut missing_candidates = Vec::new();
    let mut hidden_candidates = Vec::new();
    for existing in existing_by_path.values() {
        if scanned_paths.contains(&existing.path) {
            continue;
        }
        missing_candidates.push(existing.path.clone());
        if !existing.hidden {
            hidden_candidates.push(existing.path.clone());
        }
    }
    sort_rel_paths(&mut missing_candidates);
    sort_rel_paths(&mut hidden_candidates);
    sort_rel_paths(&mut thumb_job_candidates);

    let total = images.len().min(i32::MAX as usize) as i32;
    let scan_json = json!({
        "root_path": parsed.root_path,
        "total": images.len(),
        "paths": paths,
        "images": images,
        "missing_candidates": missing_candidates,
        "hidden_candidates": hidden_candidates,
        "thumb_job_candidates": thumb_job_candidates,
        "shadow": true,
        "duration_ms": started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    });

    Ok((scan_json, total))
}

fn run_authoritative_scan(conn: &Connection, payload: Value, job_id: &str) -> Result<i32, String> {
    let parsed: RescanJobPayload =
        serde_json::from_value(payload).map_err(|e| format!("invalid rescan payload: {e}"))?;
    let root = PathBuf::from(&parsed.root_path);
    let image_paths = scan_image_paths(&root)?;
    let total = image_paths.len().min(i32::MAX as usize) as i32;
    let queue_thumbs = thumb_queue_enabled();

    touch_sqlite_job_progress(conn, job_id, 0, Some(total))?;
    mark_images_hidden_for_root(conn, &parsed.root_path)?;
    let existing_by_rel = load_existing_image_ids(conn, &parsed.root_path)?;

    let mut done = 0_i32;
    for image_path in image_paths {
        let image = build_scanned_image(&root, &image_path)?;
        process_authoritative_image(
            conn,
            &root,
            &parsed.root_path,
            &image,
            &existing_by_rel,
            queue_thumbs,
        )?;

        done = done.saturating_add(1);
        if done % 20 == 0 || done == total {
            touch_sqlite_job_progress(conn, job_id, done, Some(total))?;
        }
    }

    cleanup_hidden_image_tag_data(conn)?;
    Ok(total)
}

async fn run_worker_loop(
    db_path: PathBuf,
    worker_id: String,
    mode: WorkerMode,
    poll_ms: u64,
    slow_ms: u128,
) -> Result<(), String> {
    let conn = open_sqlite_runtime_db(&db_path)
        .map_err(|e| format!("open sqlite db {}: {e}", db_path.display()))?;

    loop {
        let claimed = match mode {
            WorkerMode::Shadow => claim_next_sqlite_scanner_shadow_job(&conn, &worker_id)?,
            WorkerMode::Authoritative => claim_next_sqlite_rescan_job(&conn, &worker_id)?,
        };
        let Some(job) = claimed else {
            sleep(Duration::from_millis(poll_ms)).await;
            continue;
        };

        let started_at = Instant::now();
        match mode {
            WorkerMode::Shadow => match build_shadow_scan(&conn, job.payload.clone()) {
                Ok((scan_json, total)) => {
                    let total_ms = started_at.elapsed().as_millis();
                    let root = scan_json
                        .get("root_path")
                        .and_then(|value| value.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    if let Err(e) =
                        mark_sqlite_scanner_shadow_succeeded(&conn, &job, scan_json, total)
                    {
                        eprintln!(
                            "[rust-scanner-worker] mark success failed worker={} job={} error={}",
                            worker_id, job.id, e
                        );
                    }
                    eprintln!(
                        "[rust-scanner-worker] job_done worker={} job={} root={} total={} total_ms={}",
                        worker_id, job.id, root, total, total_ms
                    );
                    if total_ms >= slow_ms {
                        eprintln!(
                            "[rust-scanner-worker] slow_job worker={} job={} root={} total={} total_ms={}",
                            worker_id, job.id, root, total, total_ms
                        );
                    }
                }
                Err(err) => {
                    let total_ms = started_at.elapsed().as_millis();
                    eprintln!(
                        "[rust-scanner-worker] job_failed worker={} job={} total_ms={} error={}",
                        worker_id, job.id, total_ms, err
                    );
                    if let Err(e) = mark_sqlite_scanner_shadow_failed(
                        &conn,
                        &job,
                        &err,
                        Some(total_ms),
                        SCANNER_MAX_BACKOFF_SEC,
                    ) {
                        eprintln!(
                            "[rust-scanner-worker] mark fail failed worker={} job={} error={}",
                            worker_id, job.id, e
                        );
                    }
                }
            },
            WorkerMode::Authoritative => {
                match run_authoritative_scan(&conn, job.payload.clone(), &job.id) {
                    Ok(total) => {
                        let total_ms = started_at.elapsed().as_millis();
                        if let Err(e) = mark_sqlite_rescan_succeeded(&conn, &job, total) {
                            eprintln!(
                            "[rust-scanner-worker] mark rescan success failed worker={} job={} error={}",
                            worker_id, job.id, e
                        );
                        }
                        eprintln!(
                        "[rust-scanner-worker] rescan_done worker={} job={} total={} total_ms={}",
                        worker_id, job.id, total, total_ms
                    );
                        if total_ms >= slow_ms {
                            eprintln!(
                            "[rust-scanner-worker] slow_rescan worker={} job={} total={} total_ms={}",
                            worker_id, job.id, total, total_ms
                        );
                        }
                    }
                    Err(err) => {
                        let total_ms = started_at.elapsed().as_millis();
                        eprintln!(
                        "[rust-scanner-worker] rescan_failed worker={} job={} total_ms={} error={}",
                        worker_id, job.id, total_ms, err
                    );
                        if let Err(e) =
                            mark_sqlite_rescan_failed(&conn, &job, &err, SCANNER_MAX_BACKOFF_SEC)
                        {
                            eprintln!(
                            "[rust-scanner-worker] mark rescan fail failed worker={} job={} error={}",
                            worker_id, job.id, e
                        );
                        }
                    }
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
    let mode = worker_mode();
    let worker_id = match mode {
        WorkerMode::Shadow => format!("rust-scanner-shadow-{}", now_unix()),
        WorkerMode::Authoritative => format!("rust-scanner-rescan-{}", now_unix()),
    };
    let poll_ms = parse_poll_ms();
    let slow_ms = parse_u64_env("IMGVIEWER_SCANNER_SLOW_MS", 2000) as u128;

    eprintln!(
        "[rust-scanner-worker] started as {} mode={:?} sqlite={}",
        worker_id,
        mode,
        db_path.display()
    );
    run_worker_loop(db_path, worker_id, mode, poll_ms, slow_ms).await
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("[rust-scanner-worker] fatal: {e}");
        std::process::exit(1);
    }
}

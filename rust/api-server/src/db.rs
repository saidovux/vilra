use crate::{
    config::AppConfig,
    error::ApiError,
    live::{EventHub, LiveIndexer},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tagimage_db::sqlite::{
    self, clean_sqlite_tag_list, count_sqlite_jobs, count_sqlite_stale_running_jobs,
    create_sqlite_user_tag_entry, delete_sqlite_tag_definition, fetch_sqlite_tags_for_image_ids,
    folder_sqlite_tree_rows, get_sqlite_image_by_id, get_sqlite_job_api_value, list_sqlite_jobs,
    list_sqlite_thumb_rebuild_rows, load_sqlite_session, open_sqlite_runtime_db,
    query_sqlite_images_page, save_sqlite_session_value, set_sqlite_session_root,
    sqlite_roots_from_session, tag_sqlite_summary_rows, update_sqlite_tag_definition,
    SqliteAutoTagCleanupResult, SqliteImagesQuery, SqliteSession,
};

const VALID_JOB_STATES: &[&str] = &["queued", "running", "succeeded", "failed", "canceled"];
const INDEX_DIR_NAME: &str = ".imgindex";
const THUMBS_DIR_NAME: &str = "thumbs";

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub live: LiveIndexer,
    pub events: std::sync::Arc<EventHub>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub root_path: Option<String>,
    pub root_paths: Vec<String>,
    pub search_tags: Vec<String>,
    pub search_mode: String,
    pub last_image_id: Option<String>,
    pub tabs: Value,
    pub active_tab_id: Option<String>,
    pub folder_tag_sync: bool,
}

#[derive(Debug, Clone)]
pub struct ImageRecord {
    pub id: String,
    pub root_path: String,
    pub path: String,
    pub thumb: String,
    pub size: i64,
    pub mtime: i64,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone)]
pub struct ImageRow {
    pub id: String,
    pub path: String,
    pub thumb: String,
    pub size: i64,
    pub mtime: i64,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Default)]
pub struct ImagesQuery {
    pub tags: Option<String>,
    pub include_tags: Option<String>,
    pub exclude_tags: Option<String>,
    pub match_mode: Option<String>,
    pub mode: Option<String>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub sort: Option<String>,
    pub include_total: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ThumbRebuildInput {
    pub stale_only: bool,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct ThumbRebuildResult {
    pub enqueued: i64,
    pub queued_existing: i64,
    pub skipped: i64,
    pub total: i64,
}

impl AppState {
    pub fn new(config: AppConfig, live: LiveIndexer, events: std::sync::Arc<EventHub>) -> Self {
        Self {
            config,
            live,
            events,
        }
    }

    pub fn connect(&self) -> Result<Connection, ApiError> {
        open_sqlite_runtime_db(&self.config.sqlite_path)
            .map_err(|e| ApiError::internal(format!("Database error: {e}")))
    }

    pub fn db_health(&self) -> Value {
        let health = sqlite::check_sqlite_db_health(&self.config.sqlite_path);
        if health["db_ready"].as_bool().unwrap_or(false) {
            match self.connect() {
                Ok(conn) => {
                    if let Err(err) = sqlite::verify_sqlite_core_tables(&conn)
                        .and_then(|_| sqlite::verify_sqlite_job_tables(&conn))
                    {
                        return json!({"db_ready": false, "db_error": err});
                    }
                }
                Err(err) => return json!({"db_ready": false, "db_error": err.detail}),
            }
        }
        health
    }

    pub fn repo_path(&self, rel: &str) -> PathBuf {
        self.config.repo_root.join(rel)
    }

    pub fn thumb_rust_supported(&self) -> bool {
        packaged_runtime()
            || self.repo_path("rust/thumb-worker/Cargo.toml").exists()
            || self
                .repo_path("rust/thumb-worker/target/release/imgviewer-thumb-worker")
                .exists()
    }

    pub fn metadata_rust_supported(&self) -> bool {
        packaged_runtime()
            || self.repo_path("rust/metadata-worker/Cargo.toml").exists()
            || self
                .repo_path("rust/thumb-worker/target/release/imgviewer-metadata-worker")
                .exists()
    }
}

fn packaged_runtime() -> bool {
    std::env::var("TAGIMAGE_PACKAGED_RUNTIME")
        .map(|value| matches!(value.trim(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

#[allow(dead_code)]
pub fn normalize_tag(tag: &str) -> String {
    sqlite::normalize_sqlite_tag(tag)
}

pub fn clean_tag_list(tags: &[String]) -> Vec<String> {
    clean_sqlite_tag_list(tags)
}

fn map_db_error(error: String) -> ApiError {
    match error.as_str() {
        "Tag not found" => ApiError::not_found(error),
        "Request body must be an object"
        | "Tag name is empty"
        | "Folder tags cannot be renamed"
        | "Cannot merge into a folder tag" => ApiError::bad_request(error),
        _ if error.starts_with("No folder set") => ApiError::bad_request(error),
        _ if error.starts_with("Unsupported sort") => ApiError::bad_request(error),
        _ if error.starts_with("Not a directory") => ApiError::bad_request(error),
        _ => ApiError::internal(format!("Database error: {error}")),
    }
}

fn session_from_sqlite(session: SqliteSession) -> Session {
    Session {
        root_path: session.root_path,
        root_paths: session.root_paths,
        search_tags: session.search_tags,
        search_mode: session.search_mode,
        last_image_id: session.last_image_id,
        tabs: session.tabs,
        active_tab_id: session.active_tab_id,
        folder_tag_sync: session.folder_tag_sync,
    }
}

pub fn load_session(conn: &Connection) -> Result<Session, ApiError> {
    load_sqlite_session(conn)
        .map(session_from_sqlite)
        .map_err(map_db_error)
}

pub fn save_session_value(conn: &Connection, fields: &Value) -> Result<Session, ApiError> {
    save_sqlite_session_value(conn, fields)
        .map(session_from_sqlite)
        .map_err(map_db_error)
}

pub fn set_root(conn: &Connection, path: &str, append: bool) -> Result<Session, ApiError> {
    set_sqlite_session_root(conn, Path::new(path), append)
        .map(session_from_sqlite)
        .map_err(map_db_error)
}

pub fn roots_from_session(session: &Session) -> Vec<String> {
    sqlite_roots_from_session(&SqliteSession {
        root_path: session.root_path.clone(),
        root_paths: session.root_paths.clone(),
        search_tags: session.search_tags.clone(),
        search_mode: session.search_mode.clone(),
        last_image_id: session.last_image_id.clone(),
        tabs: session.tabs.clone(),
        active_tab_id: session.active_tab_id.clone(),
        folder_tag_sync: session.folder_tag_sync,
    })
}

pub fn require_roots(session: &Session) -> Result<Vec<String>, ApiError> {
    let roots = roots_from_session(session);
    if roots.is_empty() {
        Err(ApiError::bad_request("No folder set"))
    } else {
        Ok(roots)
    }
}

pub fn active_root(session: &Session) -> Option<String> {
    roots_from_session(session)
        .last()
        .cloned()
        .or_else(|| session.root_path.clone())
}

pub fn tag_summary_rows(conn: &Connection) -> Result<Vec<Value>, ApiError> {
    tag_sqlite_summary_rows(conn).map_err(map_db_error)
}

#[allow(dead_code)]
pub fn tag_summary_by_norm(conn: &Connection, norm: &str) -> Result<Option<Value>, ApiError> {
    Ok(tag_summary_rows(conn)?
        .into_iter()
        .find(|row| row.get("normalized").and_then(Value::as_str) == Some(norm)))
}

pub fn create_user_tag_entry(conn: &Connection, name: &str) -> Result<Value, ApiError> {
    create_sqlite_user_tag_entry(conn, name).map_err(map_db_error)
}

pub fn update_tag_definition(
    conn: &Connection,
    tag: &str,
    payload: &Value,
) -> Result<Value, ApiError> {
    update_sqlite_tag_definition(conn, tag, payload).map_err(map_db_error)
}

pub fn delete_tag_definition(conn: &Connection, tag: &str) -> Result<(), ApiError> {
    delete_sqlite_tag_definition(conn, tag).map_err(map_db_error)
}

pub fn delete_all_auto_tags(conn: &Connection) -> Result<SqliteAutoTagCleanupResult, ApiError> {
    sqlite::delete_all_sqlite_auto_tags(conn).map_err(map_db_error)
}

pub fn get_image_record(
    conn: &Connection,
    image_id: &str,
) -> Result<Option<ImageRecord>, ApiError> {
    Ok(get_sqlite_image_by_id(conn, image_id)
        .map_err(map_db_error)?
        .map(|row| ImageRecord {
            id: row.id,
            root_path: row.root_path,
            path: row.path,
            thumb: row.thumb,
            size: row.size,
            mtime: row.mtime,
            width: row.width,
            height: row.height,
        }))
}

pub fn replace_image_user_tags(
    conn: &Connection,
    image_id: &str,
    tags: &[String],
) -> Result<(), ApiError> {
    sqlite::replace_sqlite_image_user_tags(conn, image_id, tags).map_err(map_db_error)
}

pub fn fetch_tags_for_image_ids(
    conn: &Connection,
    ids: &[String],
) -> Result<HashMap<String, (Vec<String>, Vec<String>)>, ApiError> {
    fetch_sqlite_tags_for_image_ids(conn, ids).map_err(map_db_error)
}

pub fn rows_to_images(conn: &Connection, rows: Vec<ImageRow>) -> Result<Vec<Value>, ApiError> {
    let ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let tags_by_image = fetch_tags_for_image_ids(conn, &ids)?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let (auto_tags, user_tags) = tags_by_image.get(&row.id).cloned().unwrap_or_default();
            let mut combined = auto_tags.clone();
            combined.extend(user_tags.clone());
            let all_tags = clean_tag_list(&combined);
            let height = row.height.max(0);
            let width = row.width.max(0);
            let aspect_ratio = if height > 0 {
                width as f64 / height as f64
            } else {
                1.0
            };
            json!({
                "id": row.id,
                "path": row.path,
                "thumb": row.thumb,
                "thumb_url": format!("/thumb-file/{}.jpg", row.id),
                "size": row.size,
                "mtime": row.mtime,
                "width": width,
                "height": height,
                "aspect_ratio": aspect_ratio,
                "tags": all_tags,
                "auto_tags": auto_tags,
                "folder_tags": auto_tags,
                "user_tags": user_tags,
            })
        })
        .collect())
}

pub fn query_images_page(
    conn: &Connection,
    roots: &[String],
    query: ImagesQuery,
) -> Result<Value, ApiError> {
    query_sqlite_images_page(
        conn,
        roots,
        SqliteImagesQuery {
            tags: query.tags,
            include_tags: query.include_tags,
            exclude_tags: query.exclude_tags,
            match_mode: query.match_mode,
            mode: query.mode,
            limit: query.limit,
            cursor: query.cursor,
            sort: query.sort,
            include_total: query.include_total,
        },
    )
    .map_err(map_db_error)
}

pub fn folder_tree_rows(conn: &Connection, roots: &[String]) -> Result<Vec<Value>, ApiError> {
    folder_sqlite_tree_rows(conn, roots).map_err(map_db_error)
}

#[allow(dead_code)]
pub fn enqueue_job(
    conn: &Connection,
    job_type: &str,
    payload: Value,
    priority: i32,
    max_attempts: i32,
    dedupe_key: Option<String>,
) -> Result<(Value, bool), ApiError> {
    let result = sqlite::enqueue_sqlite_job(
        conn,
        job_type,
        payload,
        priority,
        max_attempts,
        dedupe_key.as_deref(),
    )
    .map_err(map_db_error)?;
    Ok((sqlite::serialize_sqlite_job(&result.job), result.deduped))
}

pub fn get_job(conn: &Connection, job_id: &str) -> Result<Option<Value>, ApiError> {
    get_sqlite_job_api_value(conn, job_id).map_err(map_db_error)
}

pub fn list_jobs(
    conn: &Connection,
    job_type: Option<&str>,
    state: Option<&str>,
    limit: i64,
) -> Result<Vec<Value>, ApiError> {
    if let Some(state) = state {
        if !VALID_JOB_STATES.contains(&state) {
            return Ok(Vec::new());
        }
    }
    list_sqlite_jobs(conn, job_type, state, limit).map_err(map_db_error)
}

pub fn count_jobs(
    conn: &Connection,
    job_type: Option<&str>,
    state: Option<&str>,
) -> Result<i64, ApiError> {
    count_sqlite_jobs(conn, job_type, state).map_err(map_db_error)
}

pub fn count_stale_running_jobs(
    conn: &Connection,
    job_type: Option<&str>,
    stale_after_sec: i64,
) -> Result<i64, ApiError> {
    count_sqlite_stale_running_jobs(conn, job_type, stale_after_sec).map_err(map_db_error)
}

pub fn enqueue_thumb_job(
    conn: &Connection,
    image_id: &str,
    root_path: &str,
    path: &str,
    thumb: &str,
    mtime: i64,
    priority: i32,
    max_attempts: i32,
) -> Result<(Value, bool), ApiError> {
    sqlite::enqueue_sqlite_thumb_job(
        conn,
        image_id,
        root_path,
        path,
        thumb,
        mtime,
        priority,
        max_attempts,
    )
    .map_err(map_db_error)
}

pub fn enqueue_thumb_rebuild_jobs(
    conn: &Connection,
    roots: &[String],
    input: ThumbRebuildInput,
    max_attempts: i32,
) -> Result<ThumbRebuildResult, ApiError> {
    if roots.is_empty() {
        return Ok(ThumbRebuildResult {
            enqueued: 0,
            queued_existing: 0,
            skipped: 0,
            total: 0,
        });
    }
    let rows = list_sqlite_thumb_rebuild_rows(conn, roots, input.limit).map_err(map_db_error)?;
    let mut enqueued = 0;
    let mut queued_existing = 0;
    let mut skipped = 0;
    for row in &rows {
        let src = Path::new(&row.root_path).join(&row.path);
        let thumb_path = Path::new(&row.root_path).join(&row.thumb);
        if input.stale_only {
            if !src.exists() {
                skipped += 1;
                continue;
            }
            if let Ok(metadata) = fs::metadata(&thumb_path) {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                        if duration.as_secs() as i64 >= row.mtime {
                            skipped += 1;
                            continue;
                        }
                    }
                }
            }
        }
        let (_, deduped) = enqueue_thumb_job(
            conn,
            &row.id,
            &row.root_path,
            &row.path,
            &row.thumb,
            row.mtime,
            20,
            max_attempts,
        )?;
        if deduped {
            queued_existing += 1;
        }
        enqueued += 1;
    }
    Ok(ThumbRebuildResult {
        enqueued,
        queued_existing,
        skipped,
        total: rows.len() as i64,
    })
}

pub fn status_payload(state: &AppState, conn: &Connection) -> Result<Value, ApiError> {
    let health = state.db_health();
    let session = load_session(conn)?;
    let roots = roots_from_session(&session);
    let root = active_root(&session);
    let live_roots = state.live.status();
    let syncing = live_roots.iter().any(|root| root.syncing);
    let done = live_roots.iter().map(|root| root.done).sum::<usize>();
    let total = live_roots.iter().map(|root| root.total).sum::<usize>();
    let sync_error = live_roots.iter().find_map(|root| root.error.clone());

    let thumb_running = count_jobs(conn, Some("thumb"), Some("running"))?;
    let thumb_queued = count_jobs(conn, Some("thumb"), Some("queued"))?;
    let thumb_stale_running =
        count_stale_running_jobs(conn, Some("thumb"), state.config.job_stale_running_sec)?;
    let metadata_running = count_jobs(conn, Some("metadata"), Some("running"))?;
    let stale_running = thumb_stale_running
        + count_stale_running_jobs(conn, Some("metadata"), state.config.job_stale_running_sec)?;
    let degraded = state.config.thumb_worker_expected
        && state.config.thumb_job_mode == "queue"
        && thumb_running == 0
        && thumb_queued > 0;

    Ok(json!({
        "ready": root.is_some() && !syncing && sync_error.is_none(),
        "root": root,
        "root_paths": roots,
        "running": syncing,
        "queued": false,
        "job_id": null,
        "total": total,
        "done": done,
        "error": sync_error,
        "db_ready": health["db_ready"],
        "db_error": health["db_error"],
        "workers": {
            "thumb_worker_expected": state.config.thumb_worker_expected,
            "capabilities": {
                "thumb": {
                    "mode": state.config.thumb_job_mode,
                    "rust_supported": state.thumb_rust_supported(),
                    "python_fallback": state.config.thumb_sync_fallback,
                },
                "filesystem": {
                    "mode": "live_filesystem",
                    "rust_supported": true,
                    "inline_worker": true,
                },
                "metadata": {
                    "mode": if !state.config.metadata_worker {
                        "not_enabled"
                    } else if state.config.metadata_authoritative {
                        "authoritative"
                    } else {
                        "shadow"
                    },
                    "rust_supported": state.metadata_rust_supported(),
                    "authoritative": state.config.metadata_worker && state.config.metadata_authoritative,
                },
                "hash": {
                    "mode": "not_enabled",
                    "rust_supported": false,
                }
            }
        },
        "queues": {
            "thumb_queue_depth": thumb_queued,
            "thumb_running": thumb_running,
            "thumb_stale_running": thumb_stale_running,
            "thumb_mode": state.config.thumb_job_mode,
            "metadata_running": metadata_running,
            "stale_running": stale_running,
            "degraded": degraded,
        },
        "filesystem": {
            "mode": "live",
            "roots": live_roots,
            "periodic_scan": false,
        },
    }))
}

pub fn thumb_path_for_id(root: &str, image_id: &str) -> PathBuf {
    Path::new(root)
        .join(INDEX_DIR_NAME)
        .join(THUMBS_DIR_NAME)
        .join(format!("{image_id}.jpg"))
}

pub fn image_thumb_path(image: &ImageRecord) -> PathBuf {
    Path::new(&image.root_path).join(&image.thumb)
}

pub fn image_file_path(image: &ImageRecord) -> PathBuf {
    Path::new(&image.root_path).join(&image.path)
}

pub fn validate_image_id(value: &str) -> bool {
    let len = value.len();
    (6..=64).contains(&len)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

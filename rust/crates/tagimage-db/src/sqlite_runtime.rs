use crate::sqlite::{
    claim_next_sqlite_job, enqueue_sqlite_job_in_tx, get_sqlite_job, insert_job_event,
    mark_sqlite_claimed_job_failed, mark_sqlite_claimed_job_succeeded,
    mark_sqlite_job_succeeded_in_tx, mark_sqlite_job_terminal_failed_in_tx,
    set_latest_attempt_state, SqliteJob,
};
use crate::sqlite_schema::SQLITE_SCHEMA_VERSION;
use base64::{engine::general_purpose::URL_SAFE, Engine as _};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tagimage_core::{
    expected_format_for_path, FileFingerprint, FileIssueKind, FileIssueSeverity,
    SupportedImageFormat,
};
use uuid::Uuid;

const DEFAULT_PAGE_LIMIT: i64 = 120;
const MAX_PAGE_LIMIT: i64 = 500;
const VALID_JOB_STATES: &[&str] = &["queued", "running", "succeeded", "failed", "canceled"];
const VALID_MATCH_MODES: &[&str] = &["any", "all"];
const IMAGE_SORTS: &[&str] = &[
    "path_asc",
    "path_desc",
    "date_desc",
    "date_asc",
    "size_desc",
    "size_asc",
];
const ACTIVE_IMAGE_PREDICATE: &str = r#"
    i.hidden = 0
    AND NOT EXISTS (
        SELECT 1
        FROM file_issues fi
        WHERE fi.severity = 'error'
          AND (fi.image_id = i.id OR (fi.root_path = i.root_path AND fi.path = i.path))
    )
"#;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SqliteSession {
    pub root_path: Option<String>,
    pub root_paths: Vec<String>,
    pub search_tags: Vec<String>,
    pub search_mode: String,
    pub last_image_id: Option<String>,
    pub tabs: JsonValue,
    pub active_tab_id: Option<String>,
    pub folder_tag_sync: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteImageRecord {
    pub id: String,
    pub root_path: String,
    pub path: String,
    pub thumb: String,
    pub size: i64,
    pub mtime: i64,
    pub width: i32,
    pub height: i32,
    pub ext: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteImageUpsert {
    pub id: Option<String>,
    pub root_path: String,
    pub path: String,
    pub thumb: String,
    pub size: i64,
    pub mtime: i64,
    pub width: i32,
    pub height: i32,
    pub ext: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteImageMetadataUpdate {
    pub size: i64,
    pub mtime: i64,
    pub width: i32,
    pub height: i32,
    pub ext: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteFileIssue {
    pub id: i64,
    pub image_id: Option<String>,
    pub root_path: String,
    pub path: String,
    pub severity: FileIssueSeverity,
    pub kind: FileIssueKind,
    pub expected_format: Option<SupportedImageFormat>,
    pub detected_format: Option<String>,
    pub size: i64,
    pub mtime_ns: i64,
    pub detail: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteFileIssueSummary {
    pub total: i64,
    pub errors: i64,
    pub warnings: i64,
    pub latest_updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteFileIssuePage {
    pub items: Vec<SqliteFileIssue>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteFileIssueRecheckTarget {
    pub id: i64,
    pub root_path: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteFileIssueUpsert {
    pub image_id: Option<String>,
    pub root_path: String,
    pub path: String,
    pub severity: FileIssueSeverity,
    pub kind: FileIssueKind,
    pub expected_format: Option<SupportedImageFormat>,
    pub detected_format: Option<String>,
    pub size: i64,
    pub mtime_ns: i64,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqliteDecodedImageRecovery {
    pub image_id: String,
    pub root_path: String,
    pub path: String,
    pub expected_format: SupportedImageFormat,
    pub detected_format: SupportedImageFormat,
    pub fingerprint: FileFingerprint,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteFileDeactivation {
    pub image: Option<SqliteImageRecord>,
    pub issue_deleted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteExistingImage {
    pub id: String,
    pub path: String,
    pub thumb: String,
    pub size: i64,
    pub mtime: i64,
    pub width: i32,
    pub height: i32,
    pub ext: String,
    pub hidden: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SqliteImagesQuery {
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

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteThumbRebuildRow {
    pub id: String,
    pub root_path: String,
    pub path: String,
    pub thumb: String,
    pub mtime: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteMetadataSourceRow {
    pub id: String,
    pub root_path: String,
    pub path: String,
    pub mtime: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteRecoveryResult {
    pub disabled: bool,
    pub checked: i64,
    pub recovered: i64,
    pub requeued: i64,
    pub failed: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteCleanupResult {
    pub removed_jobs: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteAutoTagCleanupResult {
    pub assignments_removed: i64,
    pub tags_removed: i64,
}

#[derive(Debug, Clone)]
struct SqliteImageListRow {
    id: String,
    path: String,
    thumb: String,
    size: i64,
    mtime: i64,
    width: i32,
    height: i32,
    lower_path: String,
}

#[derive(Debug, Clone)]
struct CursorPayload {
    sort: String,
    lower_path: String,
    path: String,
    id: String,
    mtime: i64,
    size: i64,
}

#[derive(Debug, Clone)]
struct TagLookup {
    id: i64,
    name: String,
    normalized: String,
    auto_count: i64,
    user_count: i64,
    user_defined: bool,
}

#[derive(Debug, Clone)]
struct StaleJob {
    job: SqliteJob,
    age_sec: i64,
}

pub fn open_sqlite_runtime_db(path: &Path) -> Result<Connection, String> {
    let conn =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e| {
            format!(
                "open sqlite runtime db {}: {e}; run ./scripts/repair-db.sh first",
                path.display()
            )
        })?;
    conn.busy_timeout(Duration::from_millis(5_000))
        .map_err(|e| format!("set sqlite runtime busy_timeout: {e}"))?;
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 5000;
        "#,
    )
    .map_err(|e| format!("set sqlite runtime pragmas: {e}"))?;

    let version = conn
        .query_row(
            "SELECT version FROM tagimage_schema_version WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| {
            format!(
                "read sqlite schema version from {}: {e}; run ./scripts/repair-db.sh first",
                path.display()
            )
        })?;
    if version != SQLITE_SCHEMA_VERSION {
        return Err(format!(
            "unsupported sqlite schema version {version}; expected {SQLITE_SCHEMA_VERSION}"
        ));
    }
    Ok(conn)
}

pub fn resolve_sqlite_runtime_path(repo_root: &Path) -> PathBuf {
    let raw = std::env::var("TAGIMAGE_SQLITE_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| ".run/tagimage.sqlite".to_string());
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        repo_root.join(path)
    }
}

pub fn open_sqlite_runtime_db_for_repo(repo_root: &Path) -> Result<Connection, String> {
    open_sqlite_runtime_db(&resolve_sqlite_runtime_path(repo_root))
}

pub fn check_sqlite_db_health(path: &Path) -> JsonValue {
    match open_sqlite_runtime_db(path) {
        Ok(conn) => {
            let ok = conn.query_row("SELECT 1", [], |row| row.get::<_, i64>(0));
            match ok {
                Ok(_) => json!({"db_ready": true, "db_error": null}),
                Err(err) => json!({"db_ready": false, "db_error": err.to_string()}),
            }
        }
        Err(err) => json!({"db_ready": false, "db_error": err}),
    }
}

pub fn verify_sqlite_core_tables(conn: &Connection) -> Result<(), String> {
    verify_sqlite_tables(
        conn,
        &[
            "tagimage_schema_version",
            "images",
            "file_issues",
            "tags",
            "suppressed_auto_tags",
            "image_tags",
            "app_session",
        ],
    )
}

pub fn verify_sqlite_job_tables(conn: &Connection) -> Result<(), String> {
    verify_sqlite_tables(conn, &["jobs", "job_attempts", "job_events"])
}

pub fn get_sqlite_file_issue(
    conn: &Connection,
    root_path: &str,
    path: &str,
) -> Result<Option<SqliteFileIssue>, String> {
    let issue = conn
        .query_row(
            "SELECT * FROM file_issues WHERE root_path = ?1 AND path = ?2",
            params![root_path, path],
            raw_sqlite_file_issue_from_row,
        )
        .optional()
        .map_err(|e| format!("get sqlite file issue {root_path}/{path}: {e}"))?;
    issue.map(SqliteFileIssue::try_from).transpose()
}

pub fn get_sqlite_file_issue_by_id(
    conn: &Connection,
    issue_id: i64,
) -> Result<Option<SqliteFileIssue>, String> {
    let issue = conn
        .query_row(
            "SELECT * FROM file_issues WHERE id = ?1",
            params![issue_id],
            raw_sqlite_file_issue_from_row,
        )
        .optional()
        .map_err(|e| format!("get sqlite file issue {issue_id}: {e}"))?;
    issue.map(SqliteFileIssue::try_from).transpose()
}

pub fn summarize_sqlite_file_issues(conn: &Connection) -> Result<SqliteFileIssueSummary, String> {
    conn.query_row(
        r#"
        SELECT
            count(*) AS total,
            count(*) FILTER (WHERE severity = 'error') AS errors,
            count(*) FILTER (WHERE severity = 'warning') AS warnings,
            max(updated_at) AS latest_updated_at
        FROM file_issues
        "#,
        [],
        |row| {
            Ok(SqliteFileIssueSummary {
                total: row.get("total")?,
                errors: row.get("errors")?,
                warnings: row.get("warnings")?,
                latest_updated_at: row.get("latest_updated_at")?,
            })
        },
    )
    .map_err(|e| format!("summarize sqlite file issues: {e}"))
}

pub fn query_sqlite_file_issues(
    conn: &Connection,
    severity: &str,
    search: &str,
    limit: i64,
    offset: i64,
) -> Result<SqliteFileIssuePage, String> {
    let total = conn
        .query_row(
            r#"
            SELECT count(*)
            FROM file_issues
            WHERE (?1 = 'all' OR severity = ?1)
              AND (?2 = '' OR instr(lower(path), lower(?2)) > 0)
            "#,
            params![severity, search],
            |row| row.get(0),
        )
        .map_err(|e| format!("count sqlite file issues: {e}"))?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT *
            FROM file_issues
            WHERE (?1 = 'all' OR severity = ?1)
              AND (?2 = '' OR instr(lower(path), lower(?2)) > 0)
            ORDER BY CASE severity WHEN 'error' THEN 0 ELSE 1 END,
                     lower(path), path, id
            LIMIT ?3 OFFSET ?4
            "#,
        )
        .map_err(|e| format!("prepare sqlite file issue page: {e}"))?;
    let rows = stmt
        .query_map(
            params![severity, search, limit, offset],
            raw_sqlite_file_issue_from_row,
        )
        .map_err(|e| format!("query sqlite file issue page: {e}"))?;
    let mut items = Vec::new();
    for row in rows {
        items.push(SqliteFileIssue::try_from(
            row.map_err(|e| format!("read sqlite file issue page: {e}"))?,
        )?);
    }
    Ok(SqliteFileIssuePage {
        items,
        total,
        limit,
        offset,
    })
}

pub fn list_sqlite_file_issue_recheck_targets(
    conn: &Connection,
) -> Result<Vec<SqliteFileIssueRecheckTarget>, String> {
    let mut stmt = conn
        .prepare("SELECT id, root_path, path FROM file_issues ORDER BY id")
        .map_err(|e| format!("prepare sqlite file issue recheck targets: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SqliteFileIssueRecheckTarget {
                id: row.get(0)?,
                root_path: row.get(1)?,
                path: row.get(2)?,
            })
        })
        .map_err(|e| format!("query sqlite file issue recheck targets: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("read sqlite file issue recheck targets: {e}"))
}

pub fn get_sqlite_file_issue_for_image(
    conn: &Connection,
    image_id: &str,
    root_path: &str,
    path: &str,
) -> Result<Option<SqliteFileIssue>, String> {
    let issue = conn
        .query_row(
            r#"
            SELECT *
            FROM file_issues
            WHERE image_id = ?1 OR (root_path = ?2 AND path = ?3)
            ORDER BY CASE WHEN image_id = ?1 THEN 0 ELSE 1 END
            LIMIT 1
            "#,
            params![image_id, root_path, path],
            raw_sqlite_file_issue_from_row,
        )
        .optional()
        .map_err(|e| format!("get sqlite file issue for image {image_id}: {e}"))?;
    issue.map(SqliteFileIssue::try_from).transpose()
}

pub fn sqlite_image_has_error_issue(
    conn: &Connection,
    image_id: &str,
    root_path: &str,
    path: &str,
) -> Result<bool, String> {
    Ok(
        get_sqlite_file_issue_for_image(conn, image_id, root_path, path)?
            .is_some_and(|issue| issue.severity == FileIssueSeverity::Error),
    )
}

pub fn list_sqlite_file_issues_for_root(
    conn: &Connection,
    root_path: &str,
) -> Result<Vec<SqliteFileIssue>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM file_issues WHERE root_path = ?1 ORDER BY lower(path), path")
        .map_err(|e| format!("prepare sqlite file issues: {e}"))?;
    let rows = stmt
        .query_map(params![root_path], raw_sqlite_file_issue_from_row)
        .map_err(|e| format!("query sqlite file issues: {e}"))?;
    let mut issues = Vec::new();
    for row in rows {
        issues.push(SqliteFileIssue::try_from(
            row.map_err(|e| format!("read sqlite file issue: {e}"))?,
        )?);
    }
    Ok(issues)
}

pub fn upsert_sqlite_file_issue(
    conn: &Connection,
    input: &SqliteFileIssueUpsert,
) -> Result<bool, String> {
    if get_sqlite_file_issue(conn, &input.root_path, &input.path)?
        .as_ref()
        .is_some_and(|existing| file_issue_matches_input(existing, input))
    {
        return Ok(false);
    }
    conn.execute(
        r#"
        INSERT INTO file_issues (
            image_id, root_path, path, severity, kind, expected_format, detected_format,
            size, mtime_ns, detail
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, max(0, ?8), ?9, ?10)
        ON CONFLICT(root_path, path) DO UPDATE SET
            image_id = excluded.image_id,
            severity = excluded.severity,
            kind = excluded.kind,
            expected_format = excluded.expected_format,
            detected_format = excluded.detected_format,
            size = excluded.size,
            mtime_ns = excluded.mtime_ns,
            detail = excluded.detail,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
        params![
            input.image_id,
            input.root_path,
            input.path,
            input.severity.as_str(),
            input.kind.as_str(),
            input.expected_format.map(SupportedImageFormat::as_str),
            input.detected_format,
            input.size,
            input.mtime_ns,
            input.detail,
        ],
    )
    .map_err(|e| {
        format!(
            "upsert sqlite file issue {}/{}: {e}",
            input.root_path, input.path
        )
    })?;
    Ok(true)
}

pub fn delete_sqlite_file_issue(
    conn: &Connection,
    root_path: &str,
    path: &str,
) -> Result<bool, String> {
    conn.execute(
        "DELETE FROM file_issues WHERE root_path = ?1 AND path = ?2",
        params![root_path, path],
    )
    .map(|count| count > 0)
    .map_err(|e| format!("delete sqlite file issue {root_path}/{path}: {e}"))
}

pub fn delete_sqlite_file_issues_under_path(
    conn: &Connection,
    root_path: &str,
    path_prefix: &str,
) -> Result<i64, String> {
    let prefix = path_prefix.trim_end_matches('/');
    let issues = list_sqlite_file_issues_for_root(conn, root_path)?
        .into_iter()
        .filter(|issue| relative_path_is_within(&issue.path, prefix))
        .collect::<Vec<_>>();
    with_immediate_tx(conn, || {
        for issue in &issues {
            conn.execute("DELETE FROM file_issues WHERE id = ?1", params![issue.id])
                .map_err(|e| format!("delete sqlite file issue {}: {e}", issue.path))?;
        }
        Ok(())
    })?;
    Ok(issues.len() as i64)
}

pub fn rename_sqlite_file_issue_path(
    conn: &Connection,
    root_path: &str,
    old_path: &str,
    new_path: &str,
) -> Result<bool, String> {
    let Some(issue) = get_sqlite_file_issue(conn, root_path, old_path)? else {
        return Ok(false);
    };
    with_immediate_tx(conn, || {
        conn.execute(
            "DELETE FROM file_issues WHERE root_path = ?1 AND path = ?2 AND id <> ?3",
            params![root_path, new_path, issue.id],
        )
        .map_err(|e| format!("remove sqlite file issue rename collision {new_path}: {e}"))?;
        conn.execute(
            r#"
            UPDATE file_issues
            SET path = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1
            "#,
            params![issue.id, new_path],
        )
        .map_err(|e| format!("rename sqlite file issue {old_path} to {new_path}: {e}"))?;
        Ok(())
    })?;
    Ok(true)
}

pub fn rename_sqlite_file_issues_under_path(
    conn: &Connection,
    root_path: &str,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<i64, String> {
    let old_prefix = old_prefix.trim_end_matches('/');
    let new_prefix = new_prefix.trim_end_matches('/');
    let candidates = list_sqlite_file_issues_for_root(conn, root_path)?
        .into_iter()
        .filter_map(|issue| {
            let suffix = relative_suffix(&issue.path, old_prefix)?.to_string();
            let next_path = if suffix.is_empty() {
                new_prefix.to_string()
            } else {
                format!("{new_prefix}/{suffix}")
            };
            Some((issue, next_path))
        })
        .collect::<Vec<_>>();
    with_immediate_tx(conn, || {
        for (issue, next_path) in &candidates {
            conn.execute(
                "DELETE FROM file_issues WHERE root_path = ?1 AND path = ?2 AND id <> ?3",
                params![root_path, next_path, issue.id],
            )
            .map_err(|e| format!("remove sqlite file issue collision {next_path}: {e}"))?;
            conn.execute(
                r#"
                UPDATE file_issues
                SET path = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
                params![issue.id, next_path],
            )
            .map_err(|e| {
                format!(
                    "rename sqlite file issue {} to {next_path}: {e}",
                    issue.path
                )
            })?;
        }
        Ok(())
    })?;
    Ok(candidates.len() as i64)
}

pub fn upsert_sqlite_image(conn: &Connection, input: &SqliteImageUpsert) -> Result<String, String> {
    let image_id = input.id.clone().unwrap_or_else(|| {
        Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(12)
            .collect()
    });
    conn.query_row(
        r#"
        INSERT INTO images (
            id, root_path, path, thumb, size, mtime, width, height, ext, hidden
        )
        VALUES (?1, ?2, ?3, ?4, max(0, ?5), ?6, max(0, ?7), max(0, ?8), ?9, 0)
        ON CONFLICT(root_path, path) DO UPDATE SET
            thumb = excluded.thumb,
            size = excluded.size,
            mtime = excluded.mtime,
            width = excluded.width,
            height = excluded.height,
            ext = excluded.ext,
            hidden = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        RETURNING id
        "#,
        params![
            image_id,
            input.root_path,
            input.path,
            input.thumb,
            input.size,
            input.mtime,
            input.width,
            input.height,
            input.ext,
        ],
        |row| row.get(0),
    )
    .map_err(|e| format!("upsert sqlite image {}: {e}", input.path))
}

pub fn get_sqlite_image_by_id(
    conn: &Connection,
    image_id: &str,
) -> Result<Option<SqliteImageRecord>, String> {
    let sql = format!("SELECT i.* FROM images i WHERE i.id = ?1 AND {ACTIVE_IMAGE_PREDICATE}");
    conn.query_row(&sql, params![image_id], sqlite_image_record_from_row)
        .optional()
        .map_err(|e| format!("get sqlite image by id {image_id}: {e}"))
}

pub fn get_sqlite_image_by_id_including_hidden(
    conn: &Connection,
    image_id: &str,
) -> Result<Option<SqliteImageRecord>, String> {
    conn.query_row(
        "SELECT * FROM images WHERE id = ?1",
        params![image_id],
        sqlite_image_record_from_row,
    )
    .optional()
    .map_err(|e| format!("get sqlite image by id including hidden {image_id}: {e}"))
}

pub fn get_sqlite_image_by_root_path(
    conn: &Connection,
    root_path: &str,
    path: &str,
) -> Result<Option<SqliteImageRecord>, String> {
    let sql = format!(
        "SELECT i.* FROM images i WHERE i.root_path = ?1 AND i.path = ?2 AND {ACTIVE_IMAGE_PREDICATE}"
    );
    conn.query_row(&sql, params![root_path, path], sqlite_image_record_from_row)
        .optional()
        .map_err(|e| format!("get sqlite image by path {root_path}/{path}: {e}"))
}

pub fn list_sqlite_existing_images_for_root(
    conn: &Connection,
    root_path: &str,
) -> Result<Vec<SqliteExistingImage>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, path, thumb, size, mtime, width, height, ext, hidden FROM images WHERE root_path = ?1 ORDER BY lower(path), path",
        )
        .map_err(|e| format!("prepare sqlite existing images: {e}"))?;
    let rows = stmt
        .query_map(params![root_path], |row| {
            Ok(SqliteExistingImage {
                id: row.get("id")?,
                path: row.get("path")?,
                thumb: row.get("thumb")?,
                size: row.get("size")?,
                mtime: row.get("mtime")?,
                width: row.get("width")?,
                height: row.get("height")?,
                ext: row.get("ext")?,
                hidden: row.get::<_, i64>("hidden")? != 0,
            })
        })
        .map_err(|e| format!("query sqlite existing images: {e}"))?;
    collect_rows(rows, "read sqlite existing image")
}

pub fn list_sqlite_existing_image_ids_for_root(
    conn: &Connection,
    root_path: &str,
) -> Result<HashMap<String, String>, String> {
    let rows = list_sqlite_existing_images_for_root(conn, root_path)?;
    Ok(rows.into_iter().map(|row| (row.path, row.id)).collect())
}

pub fn mark_sqlite_images_hidden_for_root(
    conn: &Connection,
    root_path: &str,
) -> Result<i64, String> {
    conn.execute(
        "UPDATE images SET hidden = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE root_path = ?1",
        params![root_path],
    )
    .map(|count| count as i64)
    .map_err(|e| format!("mark sqlite images hidden for root {root_path}: {e}"))
}

pub fn get_sqlite_image_by_root_path_including_hidden(
    conn: &Connection,
    root_path: &str,
    path: &str,
) -> Result<Option<SqliteImageRecord>, String> {
    conn.query_row(
        "SELECT * FROM images WHERE root_path = ?1 AND path = ?2",
        params![root_path, path],
        sqlite_image_record_from_row,
    )
    .optional()
    .map_err(|e| format!("get sqlite image by path {root_path}/{path}: {e}"))
}

pub fn hide_sqlite_image_by_root_path(
    conn: &Connection,
    root_path: &str,
    path: &str,
) -> Result<Option<SqliteImageRecord>, String> {
    let image = get_sqlite_image_by_root_path_including_hidden(conn, root_path, path)?;
    let Some(image) = image else {
        return Ok(None);
    };
    conn.execute(
        "UPDATE images SET hidden = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
        params![image.id],
    )
    .map_err(|e| format!("hide sqlite image {root_path}/{path}: {e}"))?;
    Ok(Some(image))
}

pub fn deactivate_sqlite_file_path(
    conn: &Connection,
    root_path: &str,
    path: &str,
) -> Result<SqliteFileDeactivation, String> {
    with_immediate_tx(conn, || {
        let image = get_sqlite_image_by_root_path_including_hidden(conn, root_path, path)?;
        let active_image = image.filter(|image| !image.hidden);
        if let Some(image) = &active_image {
            cancel_active_image_jobs_in_tx(conn, &image.id)?;
            conn.execute(
                r#"
                UPDATE images
                SET hidden = 1,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
                params![image.id],
            )
            .map_err(|e| format!("deactivate sqlite image {root_path}/{path}: {e}"))?;
        }
        let issue_deleted = conn
            .execute(
                "DELETE FROM file_issues WHERE root_path = ?1 AND path = ?2",
                params![root_path, path],
            )
            .map_err(|e| format!("delete sqlite file issue {root_path}/{path}: {e}"))?
            > 0;
        Ok(SqliteFileDeactivation {
            image: active_image,
            issue_deleted,
        })
    })
}

pub fn restore_sqlite_image_presence(conn: &Connection, image_id: &str) -> Result<bool, String> {
    conn.execute(
        r#"
        UPDATE images
        SET hidden = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND hidden = 1
        "#,
        params![image_id],
    )
    .map(|count| count > 0)
    .map_err(|e| format!("restore sqlite image presence {image_id}: {e}"))
}

pub fn hide_sqlite_images_under_path(
    conn: &Connection,
    root_path: &str,
    path_prefix: &str,
) -> Result<Vec<SqliteImageRecord>, String> {
    let prefix = path_prefix.trim_end_matches('/');
    let mut stmt = conn
        .prepare(
            "SELECT * FROM images WHERE root_path = ?1 AND hidden = 0 ORDER BY lower(path), path",
        )
        .map_err(|e| format!("prepare sqlite images under path: {e}"))?;
    let rows = stmt
        .query_map(params![root_path], sqlite_image_record_from_row)
        .map_err(|e| format!("query sqlite images under path: {e}"))?;
    let images = collect_rows(rows, "read sqlite image under path")?
        .into_iter()
        .filter(|image| relative_path_is_within(&image.path, prefix))
        .collect::<Vec<_>>();
    drop(stmt);

    with_immediate_tx(conn, || {
        for image in &images {
            conn.execute(
                "UPDATE images SET hidden = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?1",
                params![image.id],
            )
            .map_err(|e| format!("hide sqlite image {}: {e}", image.path))?;
        }
        Ok(())
    })?;
    Ok(images)
}

pub fn rename_sqlite_image_path(
    conn: &Connection,
    root_path: &str,
    old_path: &str,
    new_path: &str,
) -> Result<Option<SqliteImageRecord>, String> {
    let Some(image) = get_sqlite_image_by_root_path_including_hidden(conn, root_path, old_path)?
    else {
        return Ok(None);
    };
    with_immediate_tx(conn, || {
        if let Some(collision) =
            get_sqlite_image_by_root_path_including_hidden(conn, root_path, new_path)?
        {
            if collision.id != image.id {
                cancel_active_image_jobs_in_tx(conn, &collision.id)?;
                let tombstone = format!(".vilra-hidden/{}/{}", collision.id, collision.path);
                conn.execute(
                    r#"
                    UPDATE images
                    SET path = ?2,
                        hidden = 1,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?1
                    "#,
                    params![collision.id, tombstone],
                )
                .map_err(|e| format!("hide sqlite rename collision {}: {e}", collision.path))?;
            }
        }
        conn.execute(
            r#"
            UPDATE images
            SET path = ?2,
                ext = ?3,
                hidden = 0,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1
            "#,
            params![image.id, new_path, path_extension(new_path)],
        )
        .map_err(|e| format!("rename sqlite image {old_path} to {new_path}: {e}"))?;
        Ok(())
    })?;
    get_sqlite_image_by_root_path_including_hidden(conn, root_path, new_path)
}

pub fn rename_sqlite_images_under_path(
    conn: &Connection,
    root_path: &str,
    old_prefix: &str,
    new_prefix: &str,
) -> Result<Vec<SqliteImageRecord>, String> {
    let old_prefix = old_prefix.trim_end_matches('/');
    let new_prefix = new_prefix.trim_end_matches('/');
    let mut stmt = conn
        .prepare(
            "SELECT * FROM images WHERE root_path = ?1 AND hidden = 0 ORDER BY length(path), path",
        )
        .map_err(|e| format!("prepare sqlite directory rename: {e}"))?;
    let rows = stmt
        .query_map(params![root_path], sqlite_image_record_from_row)
        .map_err(|e| format!("query sqlite directory rename: {e}"))?;
    let candidates = collect_rows(rows, "read sqlite directory rename image")?
        .into_iter()
        .filter_map(|image| {
            let suffix = relative_suffix(&image.path, old_prefix).map(str::to_string);
            suffix.map(|suffix| {
                let next_path = if suffix.is_empty() {
                    new_prefix.to_string()
                } else {
                    format!("{new_prefix}/{suffix}")
                };
                (image, next_path)
            })
        })
        .collect::<Vec<_>>();
    drop(stmt);

    with_immediate_tx(conn, || {
        for (image, next_path) in &candidates {
            if let Some(collision) =
                get_sqlite_image_by_root_path_including_hidden(conn, root_path, next_path)?
            {
                if collision.id != image.id {
                    cancel_active_image_jobs_in_tx(conn, &collision.id)?;
                    let tombstone = format!(".vilra-hidden/{}/{}", collision.id, collision.path);
                    conn.execute(
                        r#"
                        UPDATE images
                        SET path = ?2,
                            hidden = 1,
                            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                        WHERE id = ?1
                        "#,
                        params![collision.id, tombstone],
                    )
                    .map_err(|e| {
                        format!(
                            "hide sqlite directory rename collision {}: {e}",
                            collision.path
                        )
                    })?;
                }
            }
            conn.execute(
                r#"
                UPDATE images
                SET path = ?2,
                    ext = ?3,
                    hidden = 0,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
                params![image.id, next_path, path_extension(next_path)],
            )
            .map_err(|e| format!("rename sqlite image {} to {next_path}: {e}", image.path))?;
        }
        Ok(())
    })?;

    candidates
        .into_iter()
        .map(|(image, next_path)| {
            get_sqlite_image_by_root_path_including_hidden(conn, root_path, &next_path)?
                .ok_or_else(|| format!("renamed sqlite image {} disappeared", image.id))
        })
        .collect()
}

pub fn retarget_sqlite_active_image_jobs(
    conn: &Connection,
    image_id: &str,
    root_path: &str,
    path: &str,
    thumb: &str,
    mtime: i64,
) -> Result<i64, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, job_type, payload
            FROM jobs
            WHERE state IN ('queued', 'running')
              AND job_type IN ('thumb', 'metadata')
            "#,
        )
        .map_err(|e| format!("prepare sqlite active image jobs: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("query sqlite active image jobs: {e}"))?;
    let mut updates = Vec::new();
    for row in rows {
        let (job_id, job_type, payload_text) =
            row.map_err(|e| format!("read sqlite active image job: {e}"))?;
        let mut payload = parse_json_text(&payload_text, json!({}));
        if payload.get("image_id").and_then(JsonValue::as_str) != Some(image_id) {
            continue;
        }
        let Some(object) = payload.as_object_mut() else {
            continue;
        };
        object.insert("root_path".to_string(), json!(root_path));
        object.insert("path".to_string(), json!(path));
        if job_type == "thumb" {
            object.insert("thumb".to_string(), json!(thumb));
            object.insert("mtime".to_string(), json!(mtime));
        }
        updates.push((job_id, payload));
    }
    drop(stmt);

    with_immediate_tx(conn, || {
        for (job_id, payload) in &updates {
            let payload = serde_json::to_string(payload)
                .map_err(|e| format!("serialize retargeted sqlite image job: {e}"))?;
            conn.execute(
                r#"
                UPDATE jobs
                SET payload = ?2,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1 AND state IN ('queued', 'running')
                "#,
                params![job_id, payload],
            )
            .map_err(|e| format!("retarget sqlite image job {job_id}: {e}"))?;
        }
        Ok(())
    })?;
    Ok(updates.len() as i64)
}

fn cancel_active_image_jobs_in_tx(conn: &Connection, image_id: &str) -> Result<(), String> {
    cancel_active_image_jobs_except_in_tx(conn, image_id, None)
}

fn cancel_active_image_jobs_except_in_tx(
    conn: &Connection,
    image_id: &str,
    exclude_job_id: Option<&str>,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, state, payload
            FROM jobs
            WHERE state IN ('queued', 'running')
              AND job_type IN ('thumb', 'metadata')
            "#,
        )
        .map_err(|e| format!("prepare sqlite image jobs for cancellation: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("query sqlite image jobs for cancellation: {e}"))?;
    let mut jobs = Vec::new();
    for row in rows {
        let (job_id, state, payload_text) =
            row.map_err(|e| format!("read sqlite image job for cancellation: {e}"))?;
        let payload = parse_json_text(&payload_text, json!({}));
        if payload.get("image_id").and_then(JsonValue::as_str) == Some(image_id)
            && exclude_job_id != Some(job_id.as_str())
        {
            jobs.push((job_id, state));
        }
    }
    drop(stmt);
    for (job_id, previous_state) in jobs {
        let changed = conn
            .execute(
                r#"
            UPDATE jobs
            SET state = 'canceled',
                finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1 AND state IN ('queued', 'running')
            "#,
                params![job_id],
            )
            .map_err(|e| format!("cancel sqlite image job {job_id}: {e}"))?;
        if changed > 0 {
            if previous_state == "running" {
                set_latest_attempt_state(conn, &job_id, "canceled", None)?;
            }
            insert_job_event(
                conn,
                &job_id,
                "canceled",
                json!({"reason": "image_unavailable"}),
            )?;
        }
    }
    Ok(())
}

pub fn cancel_sqlite_active_image_jobs(conn: &Connection, image_id: &str) -> Result<(), String> {
    with_immediate_tx(conn, || cancel_active_image_jobs_in_tx(conn, image_id))
}

pub fn cancel_sqlite_active_image_jobs_except(
    conn: &Connection,
    image_id: &str,
    exclude_job_id: &str,
) -> Result<(), String> {
    with_immediate_tx(conn, || {
        cancel_active_image_jobs_except_in_tx(conn, image_id, Some(exclude_job_id))
    })
}

pub fn get_sqlite_image_api_value(
    conn: &Connection,
    image_id: &str,
) -> Result<Option<JsonValue>, String> {
    let Some(image) = get_sqlite_image_by_id(conn, image_id)? else {
        return Ok(None);
    };
    let rows = vec![SqliteImageListRow {
        id: image.id,
        path: image.path.clone(),
        lower_path: image.path.to_lowercase(),
        thumb: image.thumb,
        size: image.size,
        mtime: image.mtime,
        width: image.width,
        height: image.height,
    }];
    Ok(rows_to_sqlite_images(conn, rows)?.into_iter().next())
}

pub fn clear_sqlite_auto_tags_for_image(conn: &Connection, image_id: &str) -> Result<i64, String> {
    conn.execute(
        "DELETE FROM image_tags WHERE image_id = ?1 AND kind = 'auto'",
        params![image_id],
    )
    .map(|count| count as i64)
    .map_err(|e| format!("clear sqlite auto tags for image {image_id}: {e}"))
}

pub fn cleanup_sqlite_hidden_image_tag_data(conn: &Connection) -> Result<(), String> {
    with_immediate_tx(conn, || {
        conn.execute(
            r#"
            DELETE FROM image_tags
            WHERE image_id IN (SELECT id FROM images WHERE hidden = 1)
            "#,
            [],
        )
        .map_err(|e| format!("cleanup sqlite hidden image tags: {e}"))?;
        conn.execute(
            r#"
            DELETE FROM tags
            WHERE user_defined = 0
              AND NOT EXISTS (
                  SELECT 1 FROM image_tags WHERE image_tags.tag_id = tags.id
              )
            "#,
            [],
        )
        .map_err(|e| format!("cleanup sqlite orphan auto tags: {e}"))?;
        Ok(())
    })
}

pub fn update_sqlite_image_metadata(
    conn: &Connection,
    image_id: &str,
    update: &SqliteImageMetadataUpdate,
) -> Result<bool, String> {
    conn.execute(
        r#"
        UPDATE images
        SET size = max(0, ?2),
            mtime = ?3,
            width = max(0, ?4),
            height = max(0, ?5),
            ext = ?6,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1
        "#,
        params![
            image_id,
            update.size,
            update.mtime,
            update.width,
            update.height,
            update.ext,
        ],
    )
    .map(|count| count > 0)
    .map_err(|e| format!("update sqlite image metadata {image_id}: {e}"))
}

pub fn count_sqlite_images(
    conn: &Connection,
    roots: &[String],
    include_hidden: bool,
) -> Result<i64, String> {
    if roots.is_empty() {
        return Ok(0);
    }
    let root_sql = placeholders(roots.len());
    let params = roots
        .iter()
        .cloned()
        .map(SqlValue::Text)
        .collect::<Vec<_>>();
    let active_sql = if include_hidden {
        String::new()
    } else {
        format!(" AND {ACTIVE_IMAGE_PREDICATE}")
    };
    let sql =
        format!("SELECT COUNT(*) FROM images i WHERE i.root_path IN ({root_sql}){active_sql}");
    conn.query_row(&sql, params_from_iter(params.iter()), |row| row.get(0))
        .map_err(|e| format!("count sqlite images: {e}"))
}

pub fn query_sqlite_images_page(
    conn: &Connection,
    roots: &[String],
    query: SqliteImagesQuery,
) -> Result<JsonValue, String> {
    if roots.is_empty() {
        return Err("No folder set".to_string());
    }
    let limit = query
        .limit
        .unwrap_or(DEFAULT_PAGE_LIMIT)
        .clamp(1, MAX_PAGE_LIMIT);
    let sort_mode = query.sort.unwrap_or_else(|| "date_desc".to_string());
    if !IMAGE_SORTS.contains(&sort_mode.as_str()) {
        return Err(format!(
            "Unsupported sort. Allowed: {}",
            IMAGE_SORTS.join(", ")
        ));
    }

    let include_source = query.include_tags.as_deref().or(query.tags.as_deref());
    let mut include_list = parse_csv_sqlite_tags(include_source);
    let mut exclude_list = parse_csv_sqlite_tags(query.exclude_tags.as_deref());
    include_list.dedup();
    exclude_list.dedup();
    let resolved_mode = if query.include_tags.is_some() {
        query.match_mode.as_deref().unwrap_or("any")
    } else {
        query.mode.as_deref().unwrap_or("any")
    };
    let resolved_mode = if VALID_MATCH_MODES.contains(&resolved_mode) {
        resolved_mode
    } else {
        "any"
    };
    let cursor_payload = decode_cursor(query.cursor.as_deref());

    let root_sql = placeholders(roots.len());
    let mut filters = vec![
        format!("i.root_path IN ({root_sql})"),
        ACTIVE_IMAGE_PREDICATE.to_string(),
    ];
    let mut params = roots
        .iter()
        .cloned()
        .map(SqlValue::Text)
        .collect::<Vec<_>>();
    let mut total_params = params.clone();

    if let Some((cursor_sql, cursor_values)) = cursor_filter_sqlite(&sort_mode, cursor_payload) {
        filters.push(cursor_sql);
        params.extend(cursor_values);
    }

    let join_sql = if include_list.is_empty() && exclude_list.is_empty() {
        ""
    } else {
        "LEFT JOIN image_tags it ON it.image_id = i.id LEFT JOIN tags t ON t.id = it.tag_id"
    };
    let mut having_clauses = Vec::new();
    let mut having_values = Vec::new();
    if !include_list.is_empty() {
        let include_sql = placeholders(include_list.len());
        if resolved_mode == "all" {
            having_clauses.push(format!(
                "COUNT(DISTINCT CASE WHEN t.normalized IN ({include_sql}) THEN t.normalized END) = ?"
            ));
            having_values.extend(include_list.iter().cloned().map(SqlValue::Text));
            having_values.push(SqlValue::Integer(include_list.len() as i64));
        } else {
            having_clauses.push(format!(
                "COUNT(DISTINCT CASE WHEN t.normalized IN ({include_sql}) THEN t.normalized END) > 0"
            ));
            having_values.extend(include_list.iter().cloned().map(SqlValue::Text));
        }
    }
    if !exclude_list.is_empty() {
        let exclude_sql = placeholders(exclude_list.len());
        having_clauses.push(format!(
            "COUNT(DISTINCT CASE WHEN t.normalized IN ({exclude_sql}) THEN t.normalized END) = 0"
        ));
        having_values.extend(exclude_list.iter().cloned().map(SqlValue::Text));
    }
    params.extend(having_values.clone());
    total_params.extend(having_values);

    let where_sql = filters.join(" AND ");
    let having_sql = if having_clauses.is_empty() {
        String::new()
    } else {
        format!("HAVING {}", having_clauses.join(" AND "))
    };
    let order_sql = sort_order_sql(&sort_mode);
    params.push(SqlValue::Integer(limit + 1));
    let sql = format!(
        r#"
        SELECT
            i.id,
            i.path,
            i.thumb,
            i.size,
            i.mtime,
            i.width,
            i.height,
            lower(i.path) AS lower_path
        FROM images i {join_sql}
        WHERE {where_sql}
        GROUP BY i.id, i.path, i.thumb, i.size, i.mtime, i.width, i.height
        {having_sql}
        ORDER BY {order_sql}
        LIMIT ?
        "#
    );

    let raw_rows = query_image_list_rows(conn, &sql, &params)?;
    let total = if query.include_total {
        let total_sql = format!(
            r#"
            WITH filtered AS (
                SELECT i.id
                FROM images i {join_sql}
                WHERE i.root_path IN ({root_sql}) AND {ACTIVE_IMAGE_PREDICATE}
                GROUP BY i.id
                {having_sql}
            )
            SELECT COUNT(*) FROM filtered
            "#
        );
        Some(
            conn.query_row(&total_sql, params_from_iter(total_params.iter()), |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|e| format!("count sqlite image page total: {e}"))?,
        )
    } else {
        None
    };

    let has_more = raw_rows.len() as i64 > limit;
    let page_rows = raw_rows
        .into_iter()
        .take(limit as usize)
        .collect::<Vec<_>>();
    let next_cursor = if has_more {
        page_rows.last().map(|row| encode_cursor(&sort_mode, row))
    } else {
        None
    };
    let rows_value = page_rows
        .iter()
        .map(|row| {
            json!({
                "id": row.id,
                "path": row.path,
                "thumb": row.thumb,
                "size": row.size,
                "mtime": row.mtime,
                "width": row.width,
                "height": row.height,
            })
        })
        .collect::<Vec<_>>();
    let items = rows_to_sqlite_images(conn, page_rows)?;
    Ok(json!({
        "rows": rows_value,
        "items": items,
        "page": {
            "next_cursor": next_cursor,
            "has_more": has_more,
            "limit": limit,
            "returned": items.len(),
            "total": total,
            "include_total": query.include_total,
            "sort": sort_mode,
        }
    }))
}

pub fn normalize_sqlite_tag(tag: &str) -> String {
    tag.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn clean_sqlite_tag_list(tags: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for tag in tags {
        let name = tag.split_whitespace().collect::<Vec<_>>().join(" ");
        let norm = normalize_sqlite_tag(&name);
        if name.is_empty() || !seen.insert(norm) {
            continue;
        }
        out.push(name);
    }
    out
}

pub fn parse_csv_sqlite_tags(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split(',')
        .filter_map(|item| {
            let norm = normalize_sqlite_tag(item);
            if norm.is_empty() {
                None
            } else {
                Some(norm)
            }
        })
        .collect()
}

pub fn tag_sqlite_summary_rows(conn: &Connection) -> Result<Vec<JsonValue>, String> {
    let sql = format!(
        r#"
            SELECT
                t.id,
                t.name,
                t.normalized,
                t.color,
                t.user_defined,
                COUNT(DISTINCT CASE WHEN i.id IS NOT NULL THEN it.image_id END) AS image_count,
                COUNT(DISTINCT CASE WHEN i.id IS NOT NULL AND it.kind = 'auto' THEN it.image_id END) AS auto_count,
                COUNT(DISTINCT CASE WHEN i.id IS NOT NULL AND it.kind = 'user' THEN it.image_id END) AS user_count
            FROM tags t
            LEFT JOIN image_tags it ON it.tag_id = t.id
            LEFT JOIN images i ON i.id = it.image_id AND {ACTIVE_IMAGE_PREDICATE}
            GROUP BY t.id
            HAVING t.user_defined = 1 OR COUNT(DISTINCT i.id) > 0
            ORDER BY lower(t.name), t.name
            "#
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sqlite tag summary: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let auto_count = row.get::<_, i64>("auto_count")?;
            let user_count = row.get::<_, i64>("user_count")?;
            let user_defined = row.get::<_, i64>("user_defined")? != 0;
            let mut sources = Vec::new();
            if auto_count > 0 {
                sources.push("auto");
            }
            if user_defined || user_count > 0 {
                sources.push("user");
            }
            Ok(json!({
                "name": row.get::<_, String>("name")?,
                "normalized": row.get::<_, String>("normalized")?,
                "color": row.get::<_, Option<String>>("color")?,
                "image_count": row.get::<_, i64>("image_count")?,
                "auto_count": auto_count,
                "user_count": user_count,
                "user_defined": user_defined,
                "is_auto": auto_count > 0,
                "source": if auto_count > 0 { "auto" } else { "user" },
                "sources": sources,
            }))
        })
        .map_err(|e| format!("query sqlite tag summary: {e}"))?;
    collect_rows(rows, "read sqlite tag summary")
}

pub fn tag_sqlite_summary_by_norm(
    conn: &Connection,
    norm: &str,
) -> Result<Option<JsonValue>, String> {
    Ok(tag_sqlite_summary_rows(conn)?
        .into_iter()
        .find(|row| row.get("normalized").and_then(JsonValue::as_str) == Some(norm)))
}

pub fn create_sqlite_user_tag_entry(conn: &Connection, name: &str) -> Result<JsonValue, String> {
    let cleaned = clean_sqlite_tag_list(&[name.to_string()]);
    let Some(name) = cleaned.first() else {
        return Err("Tag name is empty".to_string());
    };
    ensure_sqlite_tag(conn, name, true)?;
    Ok(
        tag_sqlite_summary_by_norm(conn, &normalize_sqlite_tag(name))?.unwrap_or_else(|| {
            json!({
                "name": name,
                "color": null,
                "image_count": 0,
                "auto_count": 0,
                "user_count": 0,
                "user_defined": true,
                "is_auto": false,
            })
        }),
    )
}

pub fn update_sqlite_tag_definition(
    conn: &Connection,
    tag: &str,
    payload: &JsonValue,
) -> Result<JsonValue, String> {
    let object = payload
        .as_object()
        .ok_or_else(|| "Request body must be an object".to_string())?;
    let has_name = object.contains_key("name");
    let has_color = object.contains_key("color");
    if !has_name && !has_color {
        return tag_sqlite_summary_by_norm(conn, &normalize_sqlite_tag(tag))?
            .ok_or_else(|| "Tag not found".to_string());
    }

    let new_name = if has_name {
        let raw = object.get("name").and_then(JsonValue::as_str).unwrap_or("");
        let cleaned = clean_sqlite_tag_list(&[raw.to_string()]);
        if cleaned.is_empty() {
            return Err("Tag name is empty".to_string());
        }
        Some(cleaned[0].clone())
    } else {
        None
    };
    let new_color = if has_color {
        normalize_sqlite_color(object.get("color"))?
    } else {
        None
    };
    let source_norm = normalize_sqlite_tag(tag);

    let final_norm = with_immediate_tx(conn, || {
        let source = find_sqlite_tag_lookup(conn, &source_norm)?
            .ok_or_else(|| "Tag not found".to_string())?;
        let mut target_id = source.id;
        let mut final_norm = source_norm.clone();
        if let Some(new_name) = &new_name {
            let new_norm = normalize_sqlite_tag(new_name);
            conn.execute(
                "DELETE FROM suppressed_auto_tags WHERE normalized = ?1",
                params![new_norm],
            )
            .map_err(|e| format!("delete sqlite suppressed auto tag: {e}"))?;
            let source_is_auto = source.auto_count > 0;
            if source_is_auto && new_name != &source.name {
                return Err("Folder tags cannot be renamed".to_string());
            }
            if new_norm == source.normalized {
                if new_name != &source.name {
                    conn.execute(
                        "UPDATE tags SET name = ?1, user_defined = 1 WHERE id = ?2",
                        params![new_name, source.id],
                    )
                    .map_err(|e| format!("rename sqlite tag: {e}"))?;
                } else if !source_is_auto {
                    conn.execute(
                        "UPDATE tags SET user_defined = 1 WHERE id = ?1",
                        params![source.id],
                    )
                    .map_err(|e| format!("mark sqlite tag user defined: {e}"))?;
                }
                final_norm = new_norm;
            } else {
                if source_is_auto {
                    return Err("Folder tags cannot be renamed".to_string());
                }
                if let Some(target) = find_sqlite_tag_lookup(conn, &new_norm)? {
                    if target.auto_count > 0 {
                        return Err("Cannot merge into a folder tag".to_string());
                    }
                    conn.execute(
                        r#"
                        INSERT INTO image_tags (image_id, tag_id, kind, created_at)
                        SELECT image_id, ?1, kind, created_at
                        FROM image_tags
                        WHERE tag_id = ?2
                        ON CONFLICT DO NOTHING
                        "#,
                        params![target.id, source.id],
                    )
                    .map_err(|e| format!("merge sqlite tag image links: {e}"))?;
                    conn.execute("DELETE FROM tags WHERE id = ?1", params![source.id])
                        .map_err(|e| format!("delete sqlite merged tag: {e}"))?;
                    conn.execute(
                        "UPDATE tags SET user_defined = 1 WHERE id = ?1",
                        params![target.id],
                    )
                    .map_err(|e| format!("mark sqlite merged tag user defined: {e}"))?;
                    target_id = target.id;
                    final_norm = target.normalized;
                } else {
                    conn.execute(
                        "UPDATE tags SET name = ?1, normalized = ?2, user_defined = 1 WHERE id = ?3",
                        params![new_name, new_norm, source.id],
                    )
                    .map_err(|e| format!("update sqlite tag name: {e}"))?;
                    target_id = source.id;
                    final_norm = new_norm;
                }
            }
        }
        if has_color {
            conn.execute(
                "UPDATE tags SET color = ?1 WHERE id = ?2",
                params![new_color, target_id],
            )
            .map_err(|e| format!("update sqlite tag color: {e}"))?;
        }
        Ok(final_norm)
    })?;

    tag_sqlite_summary_by_norm(conn, &final_norm)?.ok_or_else(|| "Tag not found".to_string())
}

pub fn delete_sqlite_tag_definition(conn: &Connection, tag: &str) -> Result<(), String> {
    let norm = normalize_sqlite_tag(tag);
    with_immediate_tx(conn, || {
        let row =
            find_sqlite_tag_lookup(conn, &norm)?.ok_or_else(|| "Tag not found".to_string())?;
        if row.auto_count > 0 {
            conn.execute(
                r#"
                INSERT INTO suppressed_auto_tags (normalized, name)
                VALUES (?1, ?2)
                ON CONFLICT(normalized) DO UPDATE SET name = excluded.name
                "#,
                params![row.normalized, row.name],
            )
            .map_err(|e| format!("insert sqlite suppressed auto tag: {e}"))?;
            conn.execute(
                "DELETE FROM image_tags WHERE tag_id = ?1 AND kind = 'auto'",
                params![row.id],
            )
            .map_err(|e| format!("delete sqlite auto tag links: {e}"))?;
        }
        if row.user_defined || row.user_count > 0 {
            return Ok(());
        }
        conn.execute("DELETE FROM tags WHERE id = ?1", params![row.id])
            .map_err(|e| format!("delete sqlite tag: {e}"))?;
        Ok(())
    })
}

pub fn sqlite_folder_tag_sync_enabled(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT folder_tag_sync FROM app_session WHERE id = 1",
        [],
        |row| Ok(row.get::<_, i64>(0)? != 0),
    )
    .optional()
    .map(|value| value.unwrap_or(true))
    .map_err(|e| format!("read sqlite folder tag sync setting: {e}"))
}

pub fn set_sqlite_folder_tag_sync(conn: &Connection, enabled: bool) -> Result<bool, String> {
    conn.execute(
        r#"
        INSERT INTO app_session (id, folder_tag_sync)
        VALUES (1, ?1)
        ON CONFLICT(id) DO UPDATE SET
            folder_tag_sync = excluded.folder_tag_sync,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        "#,
        params![if enabled { 1 } else { 0 }],
    )
    .map_err(|e| format!("save sqlite folder tag sync setting: {e}"))?;
    Ok(enabled)
}

pub fn delete_all_sqlite_auto_tags(
    conn: &Connection,
) -> Result<SqliteAutoTagCleanupResult, String> {
    with_immediate_tx(conn, || {
        let assignments_removed = conn
            .execute("DELETE FROM image_tags WHERE kind = 'auto'", [])
            .map_err(|e| format!("delete sqlite auto tag assignments: {e}"))?
            as i64;
        let tags_removed =
            conn.execute(
                r#"
                DELETE FROM tags
                WHERE user_defined = 0
                  AND NOT EXISTS (
                      SELECT 1 FROM image_tags WHERE image_tags.tag_id = tags.id
                  )
                "#,
                [],
            )
            .map_err(|e| format!("delete sqlite orphan auto tags: {e}"))? as i64;
        Ok(SqliteAutoTagCleanupResult {
            assignments_removed,
            tags_removed,
        })
    })
}

pub fn attach_sqlite_tag_to_image(
    conn: &Connection,
    image_id: &str,
    tag: &str,
    kind: &str,
) -> Result<Option<i64>, String> {
    let tag_id = ensure_sqlite_tag(conn, tag, kind == "user")?;
    let Some(tag_id) = tag_id else {
        return Ok(None);
    };
    conn.execute(
        r#"
        INSERT INTO image_tags (image_id, tag_id, kind)
        VALUES (?1, ?2, ?3)
        ON CONFLICT DO NOTHING
        "#,
        params![image_id, tag_id, kind],
    )
    .map_err(|e| format!("attach sqlite tag to image: {e}"))?;
    Ok(Some(tag_id))
}

pub fn detach_sqlite_tag_from_image(
    conn: &Connection,
    image_id: &str,
    tag: &str,
    kind: Option<&str>,
) -> Result<i64, String> {
    let norm = normalize_sqlite_tag(tag);
    let Some(tag_id) = find_sqlite_tag_id(conn, &norm)? else {
        return Ok(0);
    };
    let count = if let Some(kind) = kind {
        conn.execute(
            "DELETE FROM image_tags WHERE image_id = ?1 AND tag_id = ?2 AND kind = ?3",
            params![image_id, tag_id, kind],
        )
    } else {
        conn.execute(
            "DELETE FROM image_tags WHERE image_id = ?1 AND tag_id = ?2",
            params![image_id, tag_id],
        )
    }
    .map_err(|e| format!("detach sqlite tag from image: {e}"))?;
    Ok(count as i64)
}

pub fn replace_sqlite_image_tags(
    conn: &Connection,
    image_id: &str,
    tags: &[String],
    kind: &str,
) -> Result<(), String> {
    with_immediate_tx(conn, || {
        let mut cleaned = clean_sqlite_tag_list(tags);
        if kind == "auto" {
            cleaned = filter_sqlite_suppressed_auto_tags(conn, &cleaned)?;
        }
        conn.execute(
            "DELETE FROM image_tags WHERE image_id = ?1 AND kind = ?2",
            params![image_id, kind],
        )
        .map_err(|e| format!("delete sqlite image tags: {e}"))?;
        for tag in cleaned {
            attach_sqlite_tag_to_image(conn, image_id, &tag, kind)?;
        }
        Ok(())
    })
}

pub fn replace_sqlite_image_user_tags(
    conn: &Connection,
    image_id: &str,
    tags: &[String],
) -> Result<(), String> {
    replace_sqlite_image_tags(conn, image_id, tags, "user")
}

pub fn sync_sqlite_image_auto_tags(
    conn: &Connection,
    image_id: &str,
    tags: &[String],
) -> Result<bool, String> {
    let desired = filter_sqlite_suppressed_auto_tags(conn, tags)?;
    let (current, _) = list_sqlite_tags_for_image(conn, image_id)?;
    let normalized = |values: &[String]| {
        let mut values = values
            .iter()
            .map(|value| normalize_sqlite_tag(value))
            .collect::<Vec<_>>();
        values.sort();
        values.dedup();
        values
    };
    if normalized(&current) == normalized(&desired) {
        return Ok(false);
    }
    replace_sqlite_image_tags(conn, image_id, &desired, "auto")?;
    Ok(true)
}

pub fn list_sqlite_tags_for_image(
    conn: &Connection,
    image_id: &str,
) -> Result<(Vec<String>, Vec<String>), String> {
    let map = fetch_sqlite_tags_for_image_ids(conn, &[image_id.to_string()])?;
    Ok(map.get(image_id).cloned().unwrap_or_default())
}

pub fn fetch_sqlite_tags_for_image_ids(
    conn: &Connection,
    ids: &[String],
) -> Result<HashMap<String, (Vec<String>, Vec<String>)>, String> {
    let mut map = ids
        .iter()
        .map(|id| (id.clone(), (Vec::new(), Vec::new())))
        .collect::<HashMap<_, _>>();
    if ids.is_empty() {
        return Ok(map);
    }
    let id_sql = placeholders(ids.len());
    let params = ids.iter().cloned().map(SqlValue::Text).collect::<Vec<_>>();
    let sql = format!(
        r#"
        SELECT it.image_id, it.kind, t.name
        FROM image_tags it
        JOIN tags t ON t.id = it.tag_id
        WHERE it.image_id IN ({id_sql})
        ORDER BY lower(t.name), t.name
        "#
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sqlite tags for images: {e}"))?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            Ok((
                row.get::<_, String>("image_id")?,
                row.get::<_, String>("kind")?,
                row.get::<_, String>("name")?,
            ))
        })
        .map_err(|e| format!("query sqlite tags for images: {e}"))?;
    for row in rows {
        let (image_id, kind, name) = row.map_err(|e| format!("read sqlite image tag: {e}"))?;
        let entry = map.entry(image_id).or_default();
        if kind == "auto" {
            entry.0.push(name);
        } else {
            entry.1.push(name);
        }
    }
    Ok(map)
}

pub fn list_sqlite_images_by_tag(
    conn: &Connection,
    tag: &str,
) -> Result<Vec<SqliteImageRecord>, String> {
    let norm = normalize_sqlite_tag(tag);
    let sql = format!(
        r#"
            SELECT i.*
            FROM images i
            JOIN image_tags it ON it.image_id = i.id
            JOIN tags t ON t.id = it.tag_id
            WHERE t.normalized = ?1 AND {ACTIVE_IMAGE_PREDICATE}
            GROUP BY i.id
            ORDER BY i.root_path, lower(i.path), i.path
            "#
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sqlite images by tag: {e}"))?;
    let rows = stmt
        .query_map(params![norm], sqlite_image_record_from_row)
        .map_err(|e| format!("query sqlite images by tag: {e}"))?;
    collect_rows(rows, "read sqlite image by tag")
}

pub fn load_sqlite_session(conn: &Connection) -> Result<SqliteSession, String> {
    let row = conn
        .query_row(
            r#"
            SELECT root_path, root_paths, search_tags, search_mode, last_image_id, tabs, active_tab_id,
                   folder_tag_sync
            FROM app_session
            WHERE id = 1
            "#,
            [],
            |row| {
                let root_paths: String = row.get("root_paths")?;
                let search_tags: String = row.get("search_tags")?;
                let tabs: String = row.get("tabs")?;
                Ok(SqliteSession {
                    root_path: row.get("root_path")?,
                    root_paths: parse_string_json_array(&root_paths),
                    search_tags: parse_string_json_array(&search_tags),
                    search_mode: row
                        .get::<_, Option<String>>("search_mode")?
                        .unwrap_or_else(|| "any".to_string()),
                    last_image_id: row.get("last_image_id")?,
                    tabs: parse_json_text(&tabs, json!([])),
                    active_tab_id: row.get("active_tab_id")?,
                    folder_tag_sync: row.get::<_, i64>("folder_tag_sync")? != 0,
                })
            },
        )
        .optional()
        .map_err(|e| format!("load sqlite session: {e}"))?;
    Ok(row.unwrap_or_else(default_session))
}

pub fn save_sqlite_session_value(
    conn: &Connection,
    fields: &JsonValue,
) -> Result<SqliteSession, String> {
    let mut session = load_sqlite_session(conn)?;
    let object = fields
        .as_object()
        .ok_or_else(|| "Request body must be an object".to_string())?;
    if let Some(value) = object.get("root_path") {
        session.root_path = value.as_str().map(|item| item.to_string());
    }
    if let Some(value) = object.get("root_paths") {
        session.root_paths = string_array(value).unwrap_or_default();
    }
    if let Some(value) = object.get("search_tags") {
        let tags = string_array(value).unwrap_or_default();
        session.search_tags = clean_sqlite_tag_list(&tags)
            .into_iter()
            .map(|tag| normalize_sqlite_tag(&tag))
            .collect();
    }
    if let Some(value) = object.get("search_mode") {
        let mode = value.as_str().unwrap_or("any");
        session.search_mode = if VALID_MATCH_MODES.contains(&mode) {
            mode.to_string()
        } else {
            "any".to_string()
        };
    }
    if object.contains_key("last_image_id") {
        session.last_image_id = object
            .get("last_image_id")
            .and_then(JsonValue::as_str)
            .map(|item| item.to_string());
    }
    if object.contains_key("tabs") {
        session.tabs = object.get("tabs").cloned().unwrap_or_else(|| json!([]));
        if session.tabs.is_null() {
            session.tabs = json!([]);
        }
    }
    if object.contains_key("active_tab_id") {
        session.active_tab_id = object
            .get("active_tab_id")
            .and_then(JsonValue::as_str)
            .map(|item| item.to_string());
    }
    if let Some(value) = object.get("folder_tag_sync").and_then(JsonValue::as_bool) {
        session.folder_tag_sync = value;
    }

    let root_paths = json_text(&session.root_paths)?;
    let search_tags = json_text(&session.search_tags)?;
    let tabs = json_text(&session.tabs)?;
    conn.execute(
        "INSERT INTO app_session (id) VALUES (1) ON CONFLICT(id) DO NOTHING",
        [],
    )
    .map_err(|e| format!("ensure sqlite app_session: {e}"))?;
    conn.execute(
        r#"
        UPDATE app_session
        SET root_path = ?1,
            root_paths = ?2,
            search_tags = ?3,
            search_mode = ?4,
            last_image_id = ?5,
            tabs = ?6,
            active_tab_id = ?7,
            folder_tag_sync = ?8,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = 1
        "#,
        params![
            session.root_path,
            root_paths,
            search_tags,
            session.search_mode,
            session.last_image_id,
            tabs,
            session.active_tab_id,
            if session.folder_tag_sync { 1 } else { 0 },
        ],
    )
    .map_err(|e| format!("save sqlite session: {e}"))?;
    load_sqlite_session(conn)
}

pub fn set_sqlite_session_root(
    conn: &Connection,
    path: &Path,
    append: bool,
) -> Result<SqliteSession, String> {
    let root =
        std::fs::canonicalize(path).map_err(|_| format!("Not a directory: {}", path.display()))?;
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }
    let root_str = root.to_string_lossy().to_string();
    let mut session = load_sqlite_session(conn)?;
    if append {
        if !session.root_paths.iter().any(|item| item == &root_str) {
            session.root_paths.push(root_str.clone());
        }
    } else {
        session.root_paths = vec![root_str.clone()];
    }
    save_sqlite_session_value(
        conn,
        &json!({
            "root_path": root_str,
            "root_paths": session.root_paths,
            "last_image_id": null,
        }),
    )
}

pub fn sqlite_roots_from_session(session: &SqliteSession) -> Vec<String> {
    let mut roots = Vec::new();
    for root in &session.root_paths {
        if !root.is_empty() && !roots.iter().any(|item| item == root) {
            roots.push(root.clone());
        }
    }
    if roots.is_empty() {
        if let Some(root) = &session.root_path {
            if !root.is_empty() {
                roots.push(root.clone());
            }
        }
    }
    roots
}

pub fn folder_sqlite_tree_rows(
    conn: &Connection,
    roots: &[String],
) -> Result<Vec<JsonValue>, String> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let root_sql = placeholders(roots.len());
    let params = roots
        .iter()
        .cloned()
        .map(SqlValue::Text)
        .collect::<Vec<_>>();
    let sql = format!(
        r#"
        SELECT i.root_path, i.path
        FROM images i
        WHERE i.root_path IN ({root_sql}) AND {ACTIVE_IMAGE_PREDICATE}
        ORDER BY i.root_path, lower(i.path), i.path
        "#
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sqlite folder tree rows: {e}"))?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            Ok(json!({
                "root_path": row.get::<_, String>("root_path")?,
                "path": row.get::<_, String>("path")?,
            }))
        })
        .map_err(|e| format!("query sqlite folder tree rows: {e}"))?;
    collect_rows(rows, "read sqlite folder tree row")
}

pub fn serialize_sqlite_job(job: &SqliteJob) -> JsonValue {
    json!({
        "id": job.id,
        "type": job.job_type,
        "state": job.state,
        "priority": job.priority,
        "attempt": job.attempt,
        "max_attempts": job.max_attempts,
        "progress": {
            "done": job.progress_done,
            "total": job.progress_total,
        },
        "error": job.error,
        "worker_id": job.worker_id,
        "payload": job.payload,
        "scheduled_at": job.scheduled_at,
        "started_at": job.started_at,
        "finished_at": job.finished_at,
        "created_at": job.created_at,
        "updated_at": job.updated_at,
    })
}

pub fn get_sqlite_job_api_value(
    conn: &Connection,
    job_id: &str,
) -> Result<Option<JsonValue>, String> {
    Ok(get_sqlite_job(conn, job_id)?
        .as_ref()
        .map(serialize_sqlite_job))
}

pub fn list_sqlite_jobs(
    conn: &Connection,
    job_type: Option<&str>,
    state: Option<&str>,
    limit: i64,
) -> Result<Vec<JsonValue>, String> {
    if let Some(state) = state {
        if !VALID_JOB_STATES.contains(&state) {
            return Ok(Vec::new());
        }
    }
    let capped_limit = limit.clamp(1, 200);
    let (sql, params) = match (job_type, state) {
        (Some(job_type), Some(state)) => (
            "SELECT * FROM jobs WHERE job_type = ?1 AND state = ?2 ORDER BY created_at DESC LIMIT ?3",
            vec![
                SqlValue::Text(job_type.to_string()),
                SqlValue::Text(state.to_string()),
                SqlValue::Integer(capped_limit),
            ],
        ),
        (Some(job_type), None) => (
            "SELECT * FROM jobs WHERE job_type = ?1 ORDER BY created_at DESC LIMIT ?2",
            vec![SqlValue::Text(job_type.to_string()), SqlValue::Integer(capped_limit)],
        ),
        (None, Some(state)) => (
            "SELECT * FROM jobs WHERE state = ?1 ORDER BY created_at DESC LIMIT ?2",
            vec![SqlValue::Text(state.to_string()), SqlValue::Integer(capped_limit)],
        ),
        (None, None) => (
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?1",
            vec![SqlValue::Integer(capped_limit)],
        ),
    };
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("prepare sqlite jobs list: {e}"))?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), sqlite_job_from_row)
        .map_err(|e| format!("query sqlite jobs list: {e}"))?;
    let jobs = collect_rows(rows, "read sqlite job row")?;
    Ok(jobs.iter().map(serialize_sqlite_job).collect())
}

pub fn count_sqlite_jobs(
    conn: &Connection,
    job_type: Option<&str>,
    state: Option<&str>,
) -> Result<i64, String> {
    if let Some(state) = state {
        if !VALID_JOB_STATES.contains(&state) {
            return Ok(0);
        }
    }
    let (sql, params) = match (job_type, state) {
        (Some(job_type), Some(state)) => (
            "SELECT COUNT(*) FROM jobs WHERE job_type = ?1 AND state = ?2",
            vec![
                SqlValue::Text(job_type.to_string()),
                SqlValue::Text(state.to_string()),
            ],
        ),
        (Some(job_type), None) => (
            "SELECT COUNT(*) FROM jobs WHERE job_type = ?1",
            vec![SqlValue::Text(job_type.to_string())],
        ),
        (None, Some(state)) => (
            "SELECT COUNT(*) FROM jobs WHERE state = ?1",
            vec![SqlValue::Text(state.to_string())],
        ),
        (None, None) => ("SELECT COUNT(*) FROM jobs", Vec::new()),
    };
    conn.query_row(sql, params_from_iter(params.iter()), |row| row.get(0))
        .map_err(|e| format!("count sqlite jobs: {e}"))
}

pub fn count_sqlite_stale_running_jobs(
    conn: &Connection,
    job_type: Option<&str>,
    stale_after_sec: i64,
) -> Result<i64, String> {
    if stale_after_sec <= 0 {
        return Ok(0);
    }
    let stale_expr = sqlite_stale_activity_expr();
    let mut params = vec![SqlValue::Integer(stale_after_sec)];
    let mut filter = format!(
        "state = 'running' AND {stale_expr} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d seconds', ?1))"
    );
    if let Some(job_type) = job_type {
        filter.push_str(" AND job_type = ?2");
        params.push(SqlValue::Text(job_type.to_string()));
    }
    let sql = format!("SELECT COUNT(*) FROM jobs WHERE {filter}");
    conn.query_row(&sql, params_from_iter(params.iter()), |row| row.get(0))
        .map_err(|e| format!("count sqlite stale running jobs: {e}"))
}

pub fn touch_sqlite_job_progress(
    conn: &Connection,
    job_id: &str,
    done: i32,
    total: Option<i32>,
) -> Result<(), String> {
    if let Some(total) = total {
        conn.execute(
            r#"
            UPDATE jobs
            SET progress_done = max(0, ?2),
                progress_total = max(0, ?3),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1
            "#,
            params![job_id, done, total],
        )
    } else {
        conn.execute(
            r#"
            UPDATE jobs
            SET progress_done = max(0, ?2),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1
            "#,
            params![job_id, done],
        )
    }
    .map_err(|e| format!("touch sqlite job progress: {e}"))?;
    Ok(())
}

pub fn cancel_sqlite_job(conn: &Connection, job_id: &str) -> Result<bool, String> {
    with_immediate_tx(conn, || {
        let previous_state = get_sqlite_job(conn, job_id)?.map(|job| job.state);
        let changed = conn
            .execute(
                r#"
                UPDATE jobs
                SET state = 'canceled',
                    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1 AND state IN ('queued', 'running')
                "#,
                params![job_id],
            )
            .map_err(|e| format!("cancel sqlite job {job_id}: {e}"))?;
        if changed == 0 {
            return Ok(false);
        }
        if previous_state.as_deref() == Some("running") {
            set_latest_attempt_state(conn, job_id, "canceled", None)?;
        }
        insert_job_event(conn, job_id, "canceled", json!({"reason": "requested"}))?;
        Ok(true)
    })
}

pub fn cleanup_sqlite_old_jobs(
    conn: &Connection,
    ttl_hours: i64,
) -> Result<SqliteCleanupResult, String> {
    let keep_hours = ttl_hours.max(1);
    let removed = conn
        .execute(
            r#"
            DELETE FROM jobs
            WHERE state IN ('succeeded', 'failed', 'canceled')
              AND finished_at IS NOT NULL
              AND finished_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d hours', ?1))
            "#,
            params![keep_hours],
        )
        .map_err(|e| format!("cleanup sqlite old jobs: {e}"))?;
    Ok(SqliteCleanupResult {
        removed_jobs: removed as i64,
    })
}

pub fn recover_sqlite_stale_running_jobs(
    conn: &Connection,
    stale_after_sec: i64,
    limit: i64,
) -> Result<SqliteRecoveryResult, String> {
    if stale_after_sec <= 0 {
        return Ok(SqliteRecoveryResult {
            disabled: true,
            checked: 0,
            recovered: 0,
            requeued: 0,
            failed: 0,
        });
    }
    let capped_limit = limit.clamp(1, 500);
    with_immediate_tx(conn, || {
        let stale_jobs = select_stale_sqlite_jobs(conn, stale_after_sec, capped_limit)?;
        let checked = stale_jobs.len() as i64;
        let mut requeued = 0;
        let mut failed = 0;
        for stale in stale_jobs {
            let job = stale.job;
            let (next_state, error, event_name) = if job.attempt < job.max_attempts {
                ("queued", "stale running job recovered", "recovered")
            } else {
                (
                    "failed",
                    "stale running job exceeded max attempts",
                    "recovered_failed",
                )
            };
            let changed = if next_state == "queued" {
                conn.execute(
                    r#"
                    UPDATE jobs
                    SET state = 'queued',
                        scheduled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                        worker_id = NULL,
                        error = ?2,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?1 AND state = 'running'
                    "#,
                    params![job.id, error],
                )
            } else {
                conn.execute(
                    r#"
                    UPDATE jobs
                    SET state = 'failed',
                        error = ?2,
                        finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?1 AND state = 'running'
                    "#,
                    params![job.id, error],
                )
            }
            .map_err(|e| format!("update sqlite stale job {}: {e}", job.id))?;
            if changed == 0 {
                continue;
            }
            set_latest_sqlite_attempt_state(conn, &job.id, next_state, Some(error))?;
            insert_sqlite_job_event(
                conn,
                &job.id,
                event_name,
                json!({
                    "attempt": job.attempt,
                    "max_attempts": job.max_attempts,
                    "previous_worker": job.worker_id,
                    "age_sec": stale.age_sec,
                    "stale_after_sec": stale_after_sec,
                    "next_state": next_state,
                }),
            )?;
            if next_state == "queued" {
                requeued += 1;
            } else {
                failed += 1;
            }
        }
        Ok(SqliteRecoveryResult {
            disabled: false,
            checked,
            recovered: requeued + failed,
            requeued,
            failed,
        })
    })
}

pub fn enqueue_sqlite_thumb_job(
    conn: &Connection,
    image_id: &str,
    root_path: &str,
    path: &str,
    thumb: &str,
    mtime: i64,
    priority: i32,
    max_attempts: i32,
) -> Result<(JsonValue, bool), String> {
    with_immediate_tx(conn, || {
        ensure_sqlite_image_job_allowed(conn, image_id, root_path, path)?;
        let mut result = enqueue_sqlite_job_in_tx(
            conn,
            "thumb",
            json!({
                "image_id": image_id,
                "root_path": root_path,
                "path": path,
                "thumb": thumb,
                "mtime": mtime,
                "max_size": [640, 640],
            }),
            priority,
            max_attempts,
            Some(&format!("thumb:{image_id}:{mtime}")),
        )?;
        promote_queued_image_job_in_tx(conn, &mut result, priority, "thumbnail")?;
        Ok((serialize_sqlite_job(&result.job), result.deduped))
    })
}

pub fn enqueue_sqlite_metadata_job(
    conn: &Connection,
    image_id: &str,
    root_path: &str,
    path: &str,
    mtime: Option<i64>,
    priority: i32,
    max_attempts: i32,
) -> Result<(JsonValue, bool), String> {
    let dedupe_key = if let Some(mtime) = mtime {
        format!("metadata:{image_id}:{mtime}")
    } else {
        format!("metadata:{image_id}")
    };
    with_immediate_tx(conn, || {
        ensure_sqlite_image_job_allowed(conn, image_id, root_path, path)?;
        let mut result = enqueue_sqlite_job_in_tx(
            conn,
            "metadata",
            json!({
                "image_id": image_id,
                "root_path": root_path,
                "path": path,
            }),
            priority,
            max_attempts,
            Some(&dedupe_key),
        )?;
        promote_queued_image_job_in_tx(conn, &mut result, priority, "metadata")?;
        Ok((serialize_sqlite_job(&result.job), result.deduped))
    })
}

fn promote_queued_image_job_in_tx(
    conn: &Connection,
    result: &mut crate::sqlite::SqliteEnqueueResult,
    priority: i32,
    label: &str,
) -> Result<(), String> {
    if result.deduped && result.job.state == "queued" && result.job.priority < priority {
        conn.execute(
            r#"
            UPDATE jobs
            SET priority = max(priority, ?2),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ?1 AND state = 'queued'
            "#,
            params![result.job.id, priority],
        )
        .map_err(|e| format!("promote queued sqlite {label} job: {e}"))?;
        if let Some(job) = get_sqlite_job(conn, &result.job.id)? {
            result.job = job;
        }
    }
    Ok(())
}

fn ensure_sqlite_image_job_allowed(
    conn: &Connection,
    image_id: &str,
    root_path: &str,
    path: &str,
) -> Result<(), String> {
    if expected_format_for_path(Path::new(path)).is_none() {
        return Err(format!("unsupported image job path: {path}"));
    }
    if sqlite_image_has_error_issue(conn, image_id, root_path, path)? {
        return Err(format!("image unavailable: {image_id}"));
    }
    Ok(())
}

pub fn list_sqlite_thumb_rebuild_rows(
    conn: &Connection,
    roots: &[String],
    limit: Option<i64>,
) -> Result<Vec<SqliteThumbRebuildRow>, String> {
    if roots.is_empty() {
        return Ok(Vec::new());
    }
    let max_rows = limit.unwrap_or(0).clamp(0, 200000);
    let root_sql = placeholders(roots.len());
    let mut params = roots
        .iter()
        .cloned()
        .map(SqlValue::Text)
        .collect::<Vec<_>>();
    let limit_sql = if max_rows > 0 {
        params.push(SqlValue::Integer(max_rows));
        " LIMIT ?"
    } else {
        ""
    };
    let sql = format!(
        r#"
        SELECT i.id, i.root_path, i.path, i.thumb, i.mtime
        FROM images i
        WHERE i.root_path IN ({root_sql}) AND {ACTIVE_IMAGE_PREDICATE}
        ORDER BY i.root_path, lower(i.path), i.path
        {limit_sql}
        "#
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sqlite thumb rebuild rows: {e}"))?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            Ok(SqliteThumbRebuildRow {
                id: row.get("id")?,
                root_path: row.get("root_path")?,
                path: row.get("path")?,
                thumb: row.get("thumb")?,
                mtime: row.get("mtime")?,
            })
        })
        .map_err(|e| format!("query sqlite thumb rebuild rows: {e}"))?;
    collect_rows(rows, "read sqlite thumb rebuild row")
}

pub fn list_sqlite_metadata_source_rows(
    conn: &Connection,
    limit: Option<i64>,
) -> Result<Vec<SqliteMetadataSourceRow>, String> {
    let max_rows = limit.unwrap_or(0).clamp(0, 200000);
    let limit_sql = if max_rows > 0 { " LIMIT ?1" } else { "" };
    let sql = format!(
        r#"
        SELECT i.id, i.root_path, i.path, i.mtime
        FROM images i
        WHERE {ACTIVE_IMAGE_PREDICATE}
        ORDER BY i.root_path, lower(i.path), i.path
        {limit_sql}
        "#
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sqlite metadata source rows: {e}"))?;
    let rows = if max_rows > 0 {
        stmt.query_map(params![max_rows], sqlite_metadata_source_row_from_row)
    } else {
        stmt.query_map([], sqlite_metadata_source_row_from_row)
    }
    .map_err(|e| format!("query sqlite metadata source rows: {e}"))?;
    collect_rows(rows, "read sqlite metadata source row")
}

pub fn claim_next_sqlite_thumb_job(
    conn: &Connection,
    worker_id: &str,
) -> Result<Option<crate::ClaimedJob>, String> {
    claim_next_sqlite_job(conn, Some("thumb"), worker_id)
}

pub fn claim_next_sqlite_metadata_job(
    conn: &Connection,
    worker_id: &str,
) -> Result<Option<crate::ClaimedJob>, String> {
    claim_next_sqlite_job(conn, Some("metadata"), worker_id)
}

pub fn mark_sqlite_metadata_succeeded(
    conn: &Connection,
    job: &crate::ClaimedJob,
    metadata_json: JsonValue,
    authoritative: bool,
) -> Result<bool, String> {
    mark_sqlite_metadata_succeeded_with_issue(conn, job, metadata_json, authoritative, None)
}

pub fn mark_sqlite_metadata_succeeded_with_issue(
    conn: &Connection,
    job: &crate::ClaimedJob,
    metadata_json: JsonValue,
    authoritative: bool,
    issue: Option<&SqliteFileIssueUpsert>,
) -> Result<bool, String> {
    let event_data = json!({
        "attempt": job.attempt,
        "completed_at": now_unix(),
        "metadata": metadata_json,
        "authoritative": authoritative,
        "shadow": !authoritative,
    });
    with_immediate_tx(conn, || {
        if !claimed_job_is_running(conn, job)? {
            return Ok(false);
        }
        if let Some(issue) = issue {
            upsert_sqlite_file_issue(conn, issue)?;
        }
        mark_sqlite_job_succeeded_in_tx(
            conn,
            &job.id,
            Some((&job.worker_id, job.attempt)),
            Some(1),
            Some(event_data),
        )
    })
}

pub fn mark_sqlite_metadata_failed(
    conn: &Connection,
    job: &crate::ClaimedJob,
    error: &str,
    total_ms: Option<u128>,
    max_backoff_sec: i64,
) -> Result<bool, String> {
    mark_sqlite_claimed_job_failed(conn, job, error, max_backoff_sec, total_ms)
}

pub fn mark_sqlite_thumb_succeeded(
    conn: &Connection,
    job: &crate::ClaimedJob,
    metrics: Option<JsonValue>,
) -> Result<bool, String> {
    let mut event_data = json!({
        "attempt": job.attempt,
        "completed_at": now_unix(),
    });
    if let Some(metrics) = metrics {
        if let Some(object) = event_data.as_object_mut() {
            object.insert("metrics".to_string(), metrics);
        }
    }
    mark_sqlite_claimed_job_succeeded(conn, job, Some(1), Some(event_data))
}

pub fn mark_sqlite_thumb_succeeded_after_decode(
    conn: &Connection,
    job: &crate::ClaimedJob,
    metrics: Option<JsonValue>,
    recovery: Option<&SqliteDecodedImageRecovery>,
) -> Result<bool, String> {
    finalize_sqlite_thumb_success(conn, job, metrics, recovery, || Ok(()))
}

pub fn finalize_sqlite_thumb_success<F>(
    conn: &Connection,
    job: &crate::ClaimedJob,
    metrics: Option<JsonValue>,
    recovery: Option<&SqliteDecodedImageRecovery>,
    publish_thumbnail: F,
) -> Result<bool, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let mut event_data = json!({
        "attempt": job.attempt,
        "completed_at": now_unix(),
    });
    if let Some(metrics) = metrics {
        if let Some(object) = event_data.as_object_mut() {
            object.insert("metrics".to_string(), metrics);
        }
    }
    with_immediate_tx(conn, || {
        if !claimed_job_is_running(conn, job)? {
            return Ok(false);
        }
        publish_thumbnail()?;
        if let Some(recovery) = recovery {
            recover_sqlite_file_issue_after_decode_in_tx(conn, recovery)?;
        }
        mark_sqlite_job_succeeded_in_tx(
            conn,
            &job.id,
            Some((&job.worker_id, job.attempt)),
            Some(1),
            Some(event_data),
        )
    })
}

fn recover_sqlite_file_issue_after_decode_in_tx(
    conn: &Connection,
    recovery: &SqliteDecodedImageRecovery,
) -> Result<(), String> {
    let Some(issue) = get_sqlite_file_issue_for_image(
        conn,
        &recovery.image_id,
        &recovery.root_path,
        &recovery.path,
    )?
    else {
        return Ok(());
    };
    if issue.severity != FileIssueSeverity::Error
        || (issue.size == recovery.fingerprint.size
            && issue.mtime_ns == recovery.fingerprint.mtime_ns)
    {
        return Ok(());
    }

    conn.execute(
        r#"
        UPDATE images
        SET hidden = 0,
            size = max(0, ?2),
            mtime = ?3,
            width = max(0, ?4),
            height = max(0, ?5),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?1 AND root_path = ?6 AND path = ?7
        "#,
        params![
            recovery.image_id,
            recovery.fingerprint.size,
            recovery.fingerprint.mtime,
            recovery.width,
            recovery.height,
            recovery.root_path,
            recovery.path,
        ],
    )
    .map_err(|e| format!("restore recovered sqlite image {}: {e}", recovery.image_id))?;

    if recovery.expected_format == recovery.detected_format {
        conn.execute(
            "DELETE FROM file_issues WHERE id = ?1 AND severity = 'error'",
            params![issue.id],
        )
        .map_err(|e| format!("delete recovered sqlite file issue {}: {e}", issue.id))?;
    } else {
        conn.execute(
            "DELETE FROM file_issues WHERE id = ?1 AND severity = 'error'",
            params![issue.id],
        )
        .map_err(|e| format!("replace recovered sqlite file issue {}: {e}", issue.id))?;
        upsert_sqlite_file_issue(
            conn,
            &SqliteFileIssueUpsert {
                image_id: Some(recovery.image_id.clone()),
                root_path: recovery.root_path.clone(),
                path: recovery.path.clone(),
                severity: FileIssueSeverity::Warning,
                kind: FileIssueKind::FormatMismatch,
                expected_format: Some(recovery.expected_format),
                detected_format: Some(recovery.detected_format.as_str().to_string()),
                size: recovery.fingerprint.size,
                mtime_ns: recovery.fingerprint.mtime_ns,
                detail: Some(format!(
                    "expected {} from extension, detected {} from content",
                    recovery.expected_format.as_str(),
                    recovery.detected_format.as_str()
                )),
            },
        )?;
    }
    Ok(())
}

pub fn mark_sqlite_thumb_failed(
    conn: &Connection,
    job: &crate::ClaimedJob,
    error: &str,
    max_backoff_sec: i64,
    total_ms: Option<u128>,
) -> Result<bool, String> {
    mark_sqlite_claimed_job_failed(conn, job, error, max_backoff_sec, total_ms)
}

pub fn mark_sqlite_image_job_terminal_failed(
    conn: &Connection,
    job: &crate::ClaimedJob,
    image_id: &str,
    error: &str,
    total_ms: Option<u128>,
) -> Result<bool, String> {
    with_immediate_tx(conn, || {
        if !claimed_job_is_running(conn, job)? {
            return Ok(false);
        }
        cancel_active_image_jobs_except_in_tx(conn, image_id, Some(&job.id))?;
        mark_sqlite_job_terminal_failed_in_tx(
            conn,
            &job.id,
            Some((&job.worker_id, job.attempt)),
            error,
            total_ms,
        )
    })
}

pub fn record_sqlite_permanent_image_job_failure(
    conn: &Connection,
    job: &crate::ClaimedJob,
    image_id: &str,
    issue: &SqliteFileIssueUpsert,
    error: &str,
    total_ms: Option<u128>,
) -> Result<bool, String> {
    with_immediate_tx(conn, || {
        if !claimed_job_is_running(conn, job)? {
            return Ok(false);
        }
        upsert_sqlite_file_issue(conn, issue)?;
        cancel_active_image_jobs_except_in_tx(conn, image_id, Some(&job.id))?;
        mark_sqlite_job_terminal_failed_in_tx(
            conn,
            &job.id,
            Some((&job.worker_id, job.attempt)),
            error,
            total_ms,
        )
    })
}

fn claimed_job_is_running(conn: &Connection, claimed: &crate::ClaimedJob) -> Result<bool, String> {
    let Some(job) = get_sqlite_job(conn, &claimed.id)? else {
        return Ok(false);
    };
    Ok(job.state == "running"
        && job.worker_id.as_deref() == Some(&claimed.worker_id)
        && job.attempt == claimed.attempt)
}

fn verify_sqlite_tables(conn: &Connection, expected: &[&str]) -> Result<(), String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map_err(|e| format!("prepare sqlite table verification: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("query sqlite tables: {e}"))?;
    let tables = rows
        .map(|row| row.map_err(|e| format!("read sqlite table name: {e}")))
        .collect::<Result<HashSet<_>, _>>()?;
    for table in expected {
        if !tables.contains(*table) {
            return Err(format!("missing sqlite table {table}"));
        }
    }
    Ok(())
}

fn sqlite_image_record_from_row(row: &Row<'_>) -> rusqlite::Result<SqliteImageRecord> {
    Ok(SqliteImageRecord {
        id: row.get("id")?,
        root_path: row.get("root_path")?,
        path: row.get("path")?,
        thumb: row.get("thumb")?,
        size: row.get("size")?,
        mtime: row.get("mtime")?,
        width: row.get("width")?,
        height: row.get("height")?,
        ext: row.get("ext")?,
        hidden: row.get::<_, i64>("hidden")? != 0,
    })
}

struct RawSqliteFileIssue {
    id: i64,
    image_id: Option<String>,
    root_path: String,
    path: String,
    severity: String,
    kind: String,
    expected_format: Option<String>,
    detected_format: Option<String>,
    size: i64,
    mtime_ns: i64,
    detail: Option<String>,
    created_at: String,
    updated_at: String,
}

fn raw_sqlite_file_issue_from_row(row: &Row<'_>) -> rusqlite::Result<RawSqliteFileIssue> {
    Ok(RawSqliteFileIssue {
        id: row.get("id")?,
        image_id: row.get("image_id")?,
        root_path: row.get("root_path")?,
        path: row.get("path")?,
        severity: row.get("severity")?,
        kind: row.get("kind")?,
        expected_format: row.get("expected_format")?,
        detected_format: row.get("detected_format")?,
        size: row.get("size")?,
        mtime_ns: row.get("mtime_ns")?,
        detail: row.get("detail")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

impl TryFrom<RawSqliteFileIssue> for SqliteFileIssue {
    type Error = String;

    fn try_from(raw: RawSqliteFileIssue) -> Result<Self, Self::Error> {
        let severity = FileIssueSeverity::parse(&raw.severity)
            .ok_or_else(|| format!("invalid sqlite file issue severity: {}", raw.severity))?;
        let kind = FileIssueKind::parse(&raw.kind)
            .ok_or_else(|| format!("invalid sqlite file issue kind: {}", raw.kind))?;
        let expected_format = raw
            .expected_format
            .as_deref()
            .map(|value| {
                SupportedImageFormat::parse(value)
                    .ok_or_else(|| format!("invalid sqlite expected image format: {value}"))
            })
            .transpose()?;
        Ok(Self {
            id: raw.id,
            image_id: raw.image_id,
            root_path: raw.root_path,
            path: raw.path,
            severity,
            kind,
            expected_format,
            detected_format: raw.detected_format,
            size: raw.size,
            mtime_ns: raw.mtime_ns,
            detail: raw.detail,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
        })
    }
}

fn file_issue_matches_input(existing: &SqliteFileIssue, input: &SqliteFileIssueUpsert) -> bool {
    existing.image_id == input.image_id
        && existing.severity == input.severity
        && existing.kind == input.kind
        && existing.expected_format == input.expected_format
        && existing.detected_format == input.detected_format
        && existing.size == input.size.max(0)
        && existing.mtime_ns == input.mtime_ns
        && existing.detail == input.detail
}

fn sqlite_image_list_row_from_row(row: &Row<'_>) -> rusqlite::Result<SqliteImageListRow> {
    Ok(SqliteImageListRow {
        id: row.get("id")?,
        path: row.get("path")?,
        thumb: row.get("thumb")?,
        size: row.get("size")?,
        mtime: row.get("mtime")?,
        width: row.get("width")?,
        height: row.get("height")?,
        lower_path: row.get("lower_path")?,
    })
}

fn sqlite_metadata_source_row_from_row(row: &Row<'_>) -> rusqlite::Result<SqliteMetadataSourceRow> {
    Ok(SqliteMetadataSourceRow {
        id: row.get("id")?,
        root_path: row.get("root_path")?,
        path: row.get("path")?,
        mtime: row.get("mtime")?,
    })
}

fn relative_path_is_within(path: &str, prefix: &str) -> bool {
    relative_suffix(path, prefix).is_some()
}

fn relative_suffix<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    if path == prefix {
        return Some("");
    }
    path.strip_prefix(prefix)?.strip_prefix('/')
}

fn path_extension(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn sqlite_job_from_row(row: &Row<'_>) -> rusqlite::Result<SqliteJob> {
    let payload_text: String = row.get("payload")?;
    Ok(SqliteJob {
        id: row.get("id")?,
        job_type: row.get("job_type")?,
        payload: parse_json_text(&payload_text, json!({})),
        dedupe_key: row.get("dedupe_key")?,
        state: row.get("state")?,
        priority: row.get("priority")?,
        attempt: row.get("attempt")?,
        max_attempts: row.get("max_attempts")?,
        progress_done: row.get("progress_done")?,
        progress_total: row.get("progress_total")?,
        error: row.get("error")?,
        worker_id: row.get("worker_id")?,
        scheduled_at: row.get("scheduled_at")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn query_image_list_rows(
    conn: &Connection,
    sql: &str,
    params: &[SqlValue],
) -> Result<Vec<SqliteImageListRow>, String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("prepare sqlite image page query: {e}"))?;
    let rows = stmt
        .query_map(
            params_from_iter(params.iter()),
            sqlite_image_list_row_from_row,
        )
        .map_err(|e| format!("query sqlite image page: {e}"))?;
    collect_rows(rows, "read sqlite image page row")
}

fn rows_to_sqlite_images(
    conn: &Connection,
    rows: Vec<SqliteImageListRow>,
) -> Result<Vec<JsonValue>, String> {
    let ids = rows.iter().map(|row| row.id.clone()).collect::<Vec<_>>();
    let tags_by_image = fetch_sqlite_tags_for_image_ids(conn, &ids)?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let (auto_tags, user_tags) = tags_by_image.get(&row.id).cloned().unwrap_or_default();
            let mut combined = auto_tags.clone();
            combined.extend(user_tags.clone());
            let all_tags = clean_sqlite_tag_list(&combined);
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

fn ensure_sqlite_tag(
    conn: &Connection,
    name: &str,
    user_defined: bool,
) -> Result<Option<i64>, String> {
    let cleaned = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let norm = normalize_sqlite_tag(&cleaned);
    if cleaned.is_empty() || norm.is_empty() {
        return Ok(None);
    }
    if user_defined {
        conn.execute(
            "DELETE FROM suppressed_auto_tags WHERE normalized = ?1",
            params![norm],
        )
        .map_err(|e| format!("delete sqlite suppressed auto tag: {e}"))?;
    }
    let row = conn
        .query_row(
            r#"
            INSERT INTO tags (name, normalized, user_defined)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(normalized) DO UPDATE SET
                name = CASE WHEN excluded.user_defined = 1 THEN excluded.name ELSE tags.name END,
                user_defined = max(tags.user_defined, excluded.user_defined)
            RETURNING id
            "#,
            params![cleaned, norm, if user_defined { 1 } else { 0 }],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("ensure sqlite tag {name}: {e}"))?;
    Ok(row)
}

fn find_sqlite_tag_id(conn: &Connection, norm: &str) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT id FROM tags WHERE normalized = ?1",
        params![norm],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("find sqlite tag id {norm}: {e}"))
}

fn find_sqlite_tag_lookup(conn: &Connection, norm: &str) -> Result<Option<TagLookup>, String> {
    conn.query_row(
        r#"
        SELECT
            t.id,
            t.name,
            t.normalized,
            t.user_defined,
            COUNT(DISTINCT CASE WHEN it.kind = 'auto' THEN it.image_id END) AS auto_count,
            COUNT(DISTINCT CASE WHEN it.kind = 'user' THEN it.image_id END) AS user_count
        FROM tags t
        LEFT JOIN image_tags it ON it.tag_id = t.id
        WHERE t.normalized = ?1
        GROUP BY t.id
        "#,
        params![norm],
        |row| {
            Ok(TagLookup {
                id: row.get("id")?,
                name: row.get("name")?,
                normalized: row.get("normalized")?,
                auto_count: row.get("auto_count")?,
                user_count: row.get("user_count")?,
                user_defined: row.get::<_, i64>("user_defined")? != 0,
            })
        },
    )
    .optional()
    .map_err(|e| format!("find sqlite tag {norm}: {e}"))
}

fn filter_sqlite_suppressed_auto_tags(
    conn: &Connection,
    tags: &[String],
) -> Result<Vec<String>, String> {
    let cleaned = clean_sqlite_tag_list(tags);
    if cleaned.is_empty() {
        return Ok(Vec::new());
    }
    let normalized = cleaned
        .iter()
        .map(|tag| normalize_sqlite_tag(tag))
        .collect::<Vec<_>>();
    let sql = format!(
        "SELECT normalized FROM suppressed_auto_tags WHERE normalized IN ({})",
        placeholders(normalized.len())
    );
    let params = normalized
        .iter()
        .cloned()
        .map(SqlValue::Text)
        .collect::<Vec<_>>();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sqlite suppressed auto tags: {e}"))?;
    let rows = stmt
        .query_map(params_from_iter(params.iter()), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| format!("query sqlite suppressed auto tags: {e}"))?;
    let suppressed = collect_rows(rows, "read sqlite suppressed auto tag")?
        .into_iter()
        .collect::<HashSet<_>>();
    Ok(cleaned
        .into_iter()
        .filter(|tag| !suppressed.contains(&normalize_sqlite_tag(tag)))
        .collect())
}

fn normalize_sqlite_color(value: Option<&JsonValue>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let raw = value
        .as_str()
        .ok_or_else(|| "Color must be a hex value like #E5E5E5".to_string())?;
    let color = raw.trim();
    if color.is_empty() {
        return Ok(None);
    }
    let bytes = color.as_bytes();
    let valid =
        bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|b| b.is_ascii_hexdigit());
    if !valid {
        return Err("Color must be a hex value like #E5E5E5".to_string());
    }
    Ok(Some(color.to_ascii_uppercase()))
}

fn default_session() -> SqliteSession {
    SqliteSession {
        root_path: None,
        root_paths: Vec::new(),
        search_tags: Vec::new(),
        search_mode: "any".to_string(),
        last_image_id: None,
        tabs: json!([]),
        active_tab_id: None,
        folder_tag_sync: true,
    }
}

fn string_array(value: &JsonValue) -> Option<Vec<String>> {
    value.as_array().map(|items| {
        items
            .iter()
            .filter_map(|item| item.as_str().map(|raw| raw.to_string()))
            .collect()
    })
}

fn parse_string_json_array(text: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(text).unwrap_or_default()
}

fn parse_json_text(text: &str, fallback: JsonValue) -> JsonValue {
    serde_json::from_str(text).unwrap_or(fallback)
}

fn json_text(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("serialize sqlite json text: {e}"))
}

fn placeholders(count: usize) -> String {
    std::iter::repeat("?")
        .take(count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn decode_cursor(raw: Option<&str>) -> Option<CursorPayload> {
    let raw = raw?;
    let bytes = URL_SAFE.decode(raw.as_bytes()).ok()?;
    let payload: JsonValue = serde_json::from_slice(&bytes).ok()?;
    let id = payload.get("id")?.as_str()?.to_string();
    if id.is_empty() {
        return None;
    }
    Some(CursorPayload {
        sort: payload
            .get("sort")
            .and_then(JsonValue::as_str)
            .unwrap_or("path_asc")
            .to_string(),
        lower_path: payload
            .get("lower_path")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .to_string(),
        path: payload
            .get("path")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .to_string(),
        id,
        mtime: payload
            .get("mtime")
            .and_then(JsonValue::as_i64)
            .unwrap_or(0),
        size: payload.get("size").and_then(JsonValue::as_i64).unwrap_or(0),
    })
}

fn encode_cursor(sort_mode: &str, row: &SqliteImageListRow) -> String {
    let mut payload = json!({
        "sort": sort_mode,
        "lower_path": row.lower_path,
        "path": row.path,
        "id": row.id,
    });
    if sort_mode.starts_with("date_") {
        payload["mtime"] = json!(row.mtime);
    }
    if sort_mode.starts_with("size_") {
        payload["size"] = json!(row.size);
    }
    let raw = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    URL_SAFE.encode(raw.as_bytes())
}

fn sort_order_sql(sort_mode: &str) -> &'static str {
    match sort_mode {
        "path_desc" => "lower_path DESC, i.path DESC, i.id DESC",
        "date_desc" => "i.mtime DESC, lower_path, i.path, i.id",
        "date_asc" => "i.mtime ASC, lower_path, i.path, i.id",
        "size_desc" => "i.size DESC, lower_path, i.path, i.id",
        "size_asc" => "i.size ASC, lower_path, i.path, i.id",
        _ => "lower_path, i.path, i.id",
    }
}

fn cursor_filter_sqlite(
    sort_mode: &str,
    cursor: Option<CursorPayload>,
) -> Option<(String, Vec<SqlValue>)> {
    let cursor = cursor?;
    if cursor.sort != sort_mode || cursor.id.is_empty() {
        return None;
    }
    let lower_path = SqlValue::Text(cursor.lower_path);
    let path = SqlValue::Text(cursor.path);
    let id = SqlValue::Text(cursor.id);
    match sort_mode {
        "path_desc" => Some((
            "(lower(i.path), i.path, i.id) < (?, ?, ?)".to_string(),
            vec![lower_path, path, id],
        )),
        "date_desc" => Some((
            "(i.mtime < ? OR (i.mtime = ? AND (lower(i.path), i.path, i.id) > (?, ?, ?)))"
                .to_string(),
            vec![
                SqlValue::Integer(cursor.mtime),
                SqlValue::Integer(cursor.mtime),
                lower_path,
                path,
                id,
            ],
        )),
        "date_asc" => Some((
            "(i.mtime > ? OR (i.mtime = ? AND (lower(i.path), i.path, i.id) > (?, ?, ?)))"
                .to_string(),
            vec![
                SqlValue::Integer(cursor.mtime),
                SqlValue::Integer(cursor.mtime),
                lower_path,
                path,
                id,
            ],
        )),
        "size_desc" => Some((
            "(i.size < ? OR (i.size = ? AND (lower(i.path), i.path, i.id) > (?, ?, ?)))"
                .to_string(),
            vec![
                SqlValue::Integer(cursor.size),
                SqlValue::Integer(cursor.size),
                lower_path,
                path,
                id,
            ],
        )),
        "size_asc" => Some((
            "(i.size > ? OR (i.size = ? AND (lower(i.path), i.path, i.id) > (?, ?, ?)))"
                .to_string(),
            vec![
                SqlValue::Integer(cursor.size),
                SqlValue::Integer(cursor.size),
                lower_path,
                path,
                id,
            ],
        )),
        _ => Some((
            "(lower(i.path), i.path, i.id) > (?, ?, ?)".to_string(),
            vec![lower_path, path, id],
        )),
    }
}

fn with_immediate_tx<T>(
    conn: &Connection,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    conn.execute_batch("BEGIN IMMEDIATE")
        .map_err(|e| format!("begin sqlite immediate tx: {e}"))?;
    match f() {
        Ok(value) => {
            conn.execute_batch("COMMIT")
                .map_err(|e| format!("commit sqlite immediate tx: {e}"))?;
            Ok(value)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

fn insert_sqlite_job_event(
    conn: &Connection,
    job_id: &str,
    event: &str,
    data: JsonValue,
) -> Result<(), String> {
    let data_text = json_text(&data)?;
    conn.execute(
        "INSERT INTO job_events (job_id, event, data) VALUES (?1, ?2, ?3)",
        params![job_id, event, data_text],
    )
    .map_err(|e| format!("insert sqlite job event {event}: {e}"))?;
    Ok(())
}

fn set_latest_sqlite_attempt_state(
    conn: &Connection,
    job_id: &str,
    state: &str,
    error: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        r#"
        UPDATE job_attempts
        SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            state = ?2,
            error = ?3
        WHERE id = (
            SELECT id
            FROM job_attempts
            WHERE job_id = ?1
            ORDER BY started_at DESC, id DESC
            LIMIT 1
        )
        "#,
        params![job_id, state, error],
    )
    .map_err(|e| format!("update sqlite latest attempt: {e}"))?;
    Ok(())
}

fn select_stale_sqlite_jobs(
    conn: &Connection,
    stale_after_sec: i64,
    limit: i64,
) -> Result<Vec<StaleJob>, String> {
    let activity = sqlite_stale_activity_expr();
    let sql = format!(
        r#"
        SELECT *,
               CAST(strftime('%s', 'now') - strftime('%s', {activity}) AS INTEGER) AS age_sec
        FROM jobs
        WHERE state = 'running'
          AND {activity} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d seconds', ?1))
        ORDER BY updated_at, started_at, created_at
        LIMIT ?2
        "#
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("prepare sqlite stale jobs: {e}"))?;
    let rows = stmt
        .query_map(params![stale_after_sec, limit], |row| {
            Ok(StaleJob {
                job: sqlite_job_from_row(row)?,
                age_sec: row.get("age_sec")?,
            })
        })
        .map_err(|e| format!("query sqlite stale jobs: {e}"))?;
    collect_rows(rows, "read sqlite stale job")
}

fn sqlite_stale_activity_expr() -> &'static str {
    "max(COALESCE(started_at, created_at, '0000-01-01T00:00:00.000Z'), COALESCE(updated_at, started_at, created_at, '0000-01-01T00:00:00.000Z'))"
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn collect_rows<T>(
    rows: impl Iterator<Item = rusqlite::Result<T>>,
    label: &str,
) -> Result<Vec<T>, String> {
    rows.map(|row| row.map_err(|e| format!("{label}: {e}")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite::{
        enqueue_sqlite_job, init_sqlite_db, list_sqlite_job_events, mark_sqlite_job_succeeded,
    };

    fn temp_db_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("tagimage.sqlite");
        (dir, db_path)
    }

    fn upsert_fixture(
        conn: &Connection,
        id: &str,
        root_path: &str,
        path: &str,
        mtime: i64,
        size: i64,
    ) -> String {
        upsert_sqlite_image(
            conn,
            &SqliteImageUpsert {
                id: Some(id.to_string()),
                root_path: root_path.to_string(),
                path: path.to_string(),
                thumb: format!(".imgindex/thumbs/{id}.jpg"),
                size,
                mtime,
                width: 640,
                height: 480,
                ext: "jpg".to_string(),
            },
        )
        .expect("upsert fixture")
    }

    #[test]
    fn runtime_open_health_and_table_verification_use_temp_db() {
        let (_dir, db_path) = temp_db_path();
        assert!(!db_path.ends_with(".run/tagimage.sqlite"));

        drop(init_sqlite_db(&db_path).expect("explicit init"));
        let conn = open_sqlite_runtime_db(&db_path).expect("open runtime db");
        verify_sqlite_core_tables(&conn).expect("core tables");
        verify_sqlite_job_tables(&conn).expect("job tables");

        let enabled: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys pragma");
        assert_eq!(enabled, 1);

        let timeout_ms: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy_timeout pragma");
        assert_eq!(timeout_ms, 5_000);

        let health = check_sqlite_db_health(&db_path);
        assert_eq!(health["db_ready"], true);
        assert_eq!(health["db_error"], JsonValue::Null);
    }

    #[test]
    fn runtime_open_requires_explicit_init_and_does_not_create_db() {
        let (_dir, db_path) = temp_db_path();

        let missing = open_sqlite_runtime_db(&db_path).expect_err("missing db should fail");
        assert!(missing.contains("open sqlite runtime db"));
        assert!(
            !db_path.exists(),
            "runtime open must not create sqlite file"
        );

        std::fs::File::create(&db_path).expect("create empty sqlite path");
        let uninitialized =
            open_sqlite_runtime_db(&db_path).expect_err("uninitialized db should fail");
        assert!(uninitialized.contains("read sqlite schema version"));
    }

    #[test]
    fn concurrent_runtime_opens_do_not_run_schema_init_or_lock() {
        let (_dir, db_path) = temp_db_path();
        drop(init_sqlite_db(&db_path).expect("explicit init"));

        let db_path = std::sync::Arc::new(db_path);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let handles = (0..8)
            .map(|_| {
                let db_path = std::sync::Arc::clone(&db_path);
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    let conn = open_sqlite_runtime_db(&db_path).expect("runtime open");
                    conn.query_row(
                        "SELECT version FROM tagimage_schema_version WHERE id = 1",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("schema version")
                })
            })
            .collect::<Vec<_>>();

        for handle in handles {
            assert_eq!(handle.join().expect("thread join"), SQLITE_SCHEMA_VERSION);
        }
    }

    #[test]
    fn runtime_path_resolution_uses_repo_relative_default_and_env_override() {
        let repo = tempfile::tempdir().expect("repo tempdir");
        std::env::remove_var("TAGIMAGE_SQLITE_PATH");
        assert_eq!(
            resolve_sqlite_runtime_path(repo.path()),
            repo.path().join(".run/tagimage.sqlite")
        );

        std::env::set_var("TAGIMAGE_SQLITE_PATH", "custom/tagimage.sqlite");
        assert_eq!(
            resolve_sqlite_runtime_path(repo.path()),
            repo.path().join("custom/tagimage.sqlite")
        );

        let absolute = repo.path().join("absolute.sqlite");
        std::env::set_var(
            "TAGIMAGE_SQLITE_PATH",
            absolute.to_string_lossy().to_string(),
        );
        assert_eq!(resolve_sqlite_runtime_path(repo.path()), absolute);
        std::env::remove_var("TAGIMAGE_SQLITE_PATH");
    }

    #[test]
    fn image_upsert_get_page_count_update_and_hidden_cleanup_work() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let root = "/photos".to_string();

        upsert_fixture(&conn, "img-a", &root, "b/bird.jpg", 200, 20);
        upsert_fixture(&conn, "img-b", &root, "a/cat.jpg", 300, 30);
        let updated = SqliteImageUpsert {
            id: Some("ignored".to_string()),
            root_path: root.clone(),
            path: "a/cat.jpg".to_string(),
            thumb: ".imgindex/thumbs/img-b-new.jpg".to_string(),
            size: 99,
            mtime: 400,
            width: 800,
            height: 600,
            ext: "jpeg".to_string(),
        };
        let existing_id = upsert_sqlite_image(&conn, &updated).expect("update existing");
        assert_eq!(existing_id, "img-b");

        let image = get_sqlite_image_by_id(&conn, "img-b")
            .expect("get image")
            .expect("image");
        assert_eq!(image.path, "a/cat.jpg");
        assert_eq!(image.thumb, ".imgindex/thumbs/img-b-new.jpg");
        assert_eq!(image.ext, "jpeg");

        let by_path = get_sqlite_image_by_root_path(&conn, &root, "a/cat.jpg")
            .expect("get path")
            .expect("path image");
        assert_eq!(by_path.id, "img-b");

        let count = count_sqlite_images(&conn, &[root.clone()], false).expect("count");
        assert_eq!(count, 2);

        let page = query_sqlite_images_page(
            &conn,
            &[root.clone()],
            SqliteImagesQuery {
                limit: Some(1),
                sort: Some("path_asc".to_string()),
                include_total: true,
                ..Default::default()
            },
        )
        .expect("page");
        assert_eq!(page["items"][0]["id"], "img-b");
        assert_eq!(page["page"]["has_more"], true);
        assert_eq!(page["page"]["total"], 2);
        let cursor = page["page"]["next_cursor"].as_str().expect("cursor");
        let next = query_sqlite_images_page(
            &conn,
            &[root.clone()],
            SqliteImagesQuery {
                cursor: Some(cursor.to_string()),
                limit: Some(1),
                sort: Some("path_asc".to_string()),
                ..Default::default()
            },
        )
        .expect("next page");
        assert_eq!(next["items"][0]["id"], "img-a");

        update_sqlite_image_metadata(
            &conn,
            "img-a",
            &SqliteImageMetadataUpdate {
                size: 55,
                mtime: 500,
                width: 320,
                height: 200,
                ext: "webp".to_string(),
            },
        )
        .expect("metadata update");
        let image = get_sqlite_image_by_id(&conn, "img-a")
            .expect("get updated")
            .expect("updated");
        assert_eq!(image.size, 55);
        assert_eq!(image.ext, "webp");

        replace_sqlite_image_tags(&conn, "img-a", &["Folder".to_string()], "auto")
            .expect("auto tag");
        mark_sqlite_images_hidden_for_root(&conn, &root).expect("hide");
        cleanup_sqlite_hidden_image_tag_data(&conn).expect("cleanup hidden tags");
        assert_eq!(
            count_sqlite_images(&conn, &[root], false).expect("visible count"),
            0
        );
        let tag_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM image_tags", [], |row| row.get(0))
            .expect("tag count");
        assert_eq!(tag_count, 0);
    }

    #[test]
    fn file_issue_severity_is_consistent_across_active_image_queries() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let root = "/photos";
        upsert_fixture(&conn, "img-a", root, "folder/a.jpg", 10, 20);
        replace_sqlite_image_tags(&conn, "img-a", &["Favorite".to_string()], "user")
            .expect("user tag");

        let issue = SqliteFileIssueUpsert {
            image_id: Some("img-a".to_string()),
            root_path: root.to_string(),
            path: "folder/a.jpg".to_string(),
            severity: FileIssueSeverity::Error,
            kind: FileIssueKind::DecodeError,
            expected_format: Some(SupportedImageFormat::Jpeg),
            detected_format: None,
            size: 20,
            mtime_ns: 100,
            detail: Some("truncated".to_string()),
        };
        assert!(upsert_sqlite_file_issue(&conn, &issue).expect("insert issue"));
        assert!(!upsert_sqlite_file_issue(&conn, &issue).expect("same issue"));
        assert!(get_sqlite_image_by_id(&conn, "img-a")
            .expect("active image")
            .is_none());
        assert_eq!(
            count_sqlite_images(&conn, &[root.to_string()], false).unwrap(),
            0
        );
        assert!(
            query_sqlite_images_page(&conn, &[root.to_string()], SqliteImagesQuery::default())
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(list_sqlite_images_by_tag(&conn, "Favorite")
            .unwrap()
            .is_empty());
        assert_eq!(
            tag_sqlite_summary_by_norm(&conn, "favorite")
                .unwrap()
                .unwrap()["image_count"],
            0
        );
        assert!(folder_sqlite_tree_rows(&conn, &[root.to_string()])
            .unwrap()
            .is_empty());
        assert!(
            list_sqlite_thumb_rebuild_rows(&conn, &[root.to_string()], None)
                .unwrap()
                .is_empty()
        );
        assert!(list_sqlite_metadata_source_rows(&conn, None)
            .unwrap()
            .is_empty());

        let warning = SqliteFileIssueUpsert {
            severity: FileIssueSeverity::Warning,
            kind: FileIssueKind::FormatMismatch,
            detected_format: Some("png".to_string()),
            detail: Some("format mismatch".to_string()),
            ..issue
        };
        assert!(upsert_sqlite_file_issue(&conn, &warning).expect("warning"));
        assert!(get_sqlite_image_by_id(&conn, "img-a").unwrap().is_some());
        assert_eq!(
            count_sqlite_images(&conn, &[root.to_string()], false).unwrap(),
            1
        );
        assert_eq!(
            list_sqlite_images_by_tag(&conn, "Favorite").unwrap().len(),
            1
        );
        assert_eq!(
            list_sqlite_thumb_rebuild_rows(&conn, &[root.to_string()], None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            list_sqlite_metadata_source_rows(&conn, None).unwrap().len(),
            1
        );
    }

    #[test]
    fn worker_terminal_issue_cancels_siblings_blocks_enqueue_and_recovers() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let root = "/photos";
        upsert_fixture(&conn, "img-a", root, "folder/a.jpg", 10, 20);
        replace_sqlite_image_tags(&conn, "img-a", &["Favorite".to_string()], "user")
            .expect("user tag");
        let (thumb, _) = enqueue_sqlite_thumb_job(
            &conn,
            "img-a",
            root,
            "folder/a.jpg",
            ".imgindex/thumbs/img-a.jpg",
            10,
            30,
            5,
        )
        .expect("thumb enqueue");
        let (metadata, _) =
            enqueue_sqlite_metadata_job(&conn, "img-a", root, "folder/a.jpg", Some(10), 10, 5)
                .expect("metadata enqueue");
        let claimed = claim_next_sqlite_thumb_job(&conn, "thumb-worker")
            .expect("claim")
            .expect("claimed");
        assert_eq!(claimed.id, thumb["id"]);

        let issue = SqliteFileIssueUpsert {
            image_id: Some("img-a".to_string()),
            root_path: root.to_string(),
            path: "folder/a.jpg".to_string(),
            severity: FileIssueSeverity::Error,
            kind: FileIssueKind::DecodeError,
            expected_format: Some(SupportedImageFormat::Jpeg),
            detected_format: Some("jpeg".to_string()),
            size: 20,
            mtime_ns: 100,
            detail: Some("full decode failed".to_string()),
        };
        assert!(record_sqlite_permanent_image_job_failure(
            &conn,
            &claimed,
            "img-a",
            &issue,
            "full decode failed",
            Some(12),
        )
        .expect("record permanent failure"));

        assert_eq!(
            get_sqlite_job(&conn, &claimed.id).unwrap().unwrap().state,
            "failed"
        );
        assert_eq!(
            get_sqlite_job(&conn, metadata["id"].as_str().unwrap())
                .unwrap()
                .unwrap()
                .state,
            "canceled"
        );
        assert!(list_sqlite_job_events(&conn, &claimed.id)
            .unwrap()
            .iter()
            .any(|event| event.event == "terminal_failed"));
        assert!(get_sqlite_image_by_id(&conn, "img-a").unwrap().is_none());
        assert_eq!(
            count_sqlite_images(&conn, &[root.to_string()], false).unwrap(),
            0
        );
        assert!(
            query_sqlite_images_page(&conn, &[root.to_string()], SqliteImagesQuery::default())
                .unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(list_sqlite_images_by_tag(&conn, "Favorite")
            .unwrap()
            .is_empty());
        assert_eq!(
            tag_sqlite_summary_by_norm(&conn, "favorite")
                .unwrap()
                .unwrap()["image_count"],
            0
        );
        assert!(folder_sqlite_tree_rows(&conn, &[root.to_string()])
            .unwrap()
            .is_empty());
        assert!(
            list_sqlite_thumb_rebuild_rows(&conn, &[root.to_string()], None)
                .unwrap()
                .is_empty()
        );
        assert!(list_sqlite_metadata_source_rows(&conn, None)
            .unwrap()
            .is_empty());

        let jobs_before = count_sqlite_jobs(&conn, None, None).unwrap();
        assert!(enqueue_sqlite_thumb_job(
            &conn,
            "img-a",
            root,
            "folder/a.jpg",
            ".imgindex/thumbs/img-a.jpg",
            10,
            30,
            5,
        )
        .is_err());
        assert!(
            enqueue_sqlite_metadata_job(&conn, "img-a", root, "folder/a.jpg", Some(10), 10, 5,)
                .is_err()
        );
        assert_eq!(count_sqlite_jobs(&conn, None, None).unwrap(), jobs_before);

        assert!(delete_sqlite_file_issue(&conn, root, "folder/a.jpg").unwrap());
        let restored = get_sqlite_image_by_id(&conn, "img-a")
            .unwrap()
            .expect("restored image");
        assert_eq!(restored.id, "img-a");
        assert_eq!(
            list_sqlite_tags_for_image(&conn, "img-a").unwrap().1,
            vec!["Favorite"]
        );
        assert!(enqueue_sqlite_thumb_job(
            &conn,
            "img-a",
            root,
            "folder/a.jpg",
            ".imgindex/thumbs/img-a.jpg",
            11,
            30,
            5,
        )
        .is_ok());
    }

    #[test]
    fn image_job_enqueue_validates_issue_and_writes_job_atomically() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let root = "/photos";
        upsert_fixture(&conn, "img-a", root, "a.jpg", 10, 20);
        let issue = SqliteFileIssueUpsert {
            image_id: Some("img-a".to_string()),
            root_path: root.to_string(),
            path: "a.jpg".to_string(),
            severity: FileIssueSeverity::Error,
            kind: FileIssueKind::DecodeError,
            expected_format: Some(SupportedImageFormat::Jpeg),
            detected_format: Some("jpeg".to_string()),
            size: 20,
            mtime_ns: 10,
            detail: Some("broken".to_string()),
        };
        upsert_sqlite_file_issue(&conn, &issue).expect("issue");
        let jobs_before = count_sqlite_jobs(&conn, None, None).expect("jobs before");

        assert!(enqueue_sqlite_thumb_job(
            &conn,
            "img-a",
            root,
            "a.jpg",
            ".imgindex/thumbs/img-a.jpg",
            10,
            20,
            3,
        )
        .is_err());
        assert!(
            enqueue_sqlite_metadata_job(&conn, "img-a", root, "a.jpg", Some(10), 20, 3,).is_err()
        );
        assert_eq!(
            count_sqlite_jobs(&conn, None, None).expect("jobs after"),
            jobs_before
        );
    }

    #[test]
    fn image_job_validation_holds_writer_lock_against_concurrent_error_issue() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        upsert_fixture(&conn, "img-a", "/photos", "a.jpg", 10, 20);
        let other = open_sqlite_runtime_db(&db_path).expect("second connection");
        other
            .busy_timeout(Duration::ZERO)
            .expect("disable wait for deterministic lock check");
        conn.execute_batch("BEGIN IMMEDIATE")
            .expect("begin image enqueue transaction");
        ensure_sqlite_image_job_allowed(&conn, "img-a", "/photos", "a.jpg")
            .expect("validate while write lock is held");
        let concurrent_issue = upsert_sqlite_file_issue(
            &other,
            &SqliteFileIssueUpsert {
                image_id: Some("img-a".to_string()),
                root_path: "/photos".to_string(),
                path: "a.jpg".to_string(),
                severity: FileIssueSeverity::Error,
                kind: FileIssueKind::DecodeError,
                expected_format: Some(SupportedImageFormat::Jpeg),
                detected_format: Some("jpeg".to_string()),
                size: 20,
                mtime_ns: 10,
                detail: Some("concurrent failure".to_string()),
            },
        )
        .expect_err("concurrent issue writer must be blocked");
        assert!(
            concurrent_issue.contains("locked") || concurrent_issue.contains("busy"),
            "unexpected sqlite lock error: {concurrent_issue}"
        );
        conn.execute_batch("ROLLBACK")
            .expect("rollback image enqueue transaction");
    }

    #[test]
    fn stale_attempt_cannot_record_permanent_issue_or_cancel_new_attempt() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let root = "/photos";
        upsert_fixture(&conn, "img-a", root, "a.jpg", 10, 20);
        enqueue_sqlite_thumb_job(
            &conn,
            "img-a",
            root,
            "a.jpg",
            ".imgindex/thumbs/img-a.jpg",
            10,
            20,
            3,
        )
        .expect("enqueue thumb");
        let attempt_one = claim_next_sqlite_thumb_job(&conn, "same-worker")
            .expect("claim one")
            .expect("attempt one");
        conn.execute(
            "UPDATE jobs SET started_at = '2000-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1",
            params![attempt_one.id],
        )
        .expect("age attempt one");
        assert_eq!(
            recover_sqlite_stale_running_jobs(&conn, 1, 10)
                .expect("recover")
                .requeued,
            1
        );
        let attempt_two = claim_next_sqlite_thumb_job(&conn, "same-worker")
            .expect("claim two")
            .expect("attempt two");
        let events_before = list_sqlite_job_events(&conn, &attempt_one.id)
            .expect("events before")
            .len();
        let issue = SqliteFileIssueUpsert {
            image_id: Some("img-a".to_string()),
            root_path: root.to_string(),
            path: "a.jpg".to_string(),
            severity: FileIssueSeverity::Error,
            kind: FileIssueKind::DecodeError,
            expected_format: Some(SupportedImageFormat::Jpeg),
            detected_format: Some("jpeg".to_string()),
            size: 20,
            mtime_ns: 10,
            detail: Some("late error".to_string()),
        };

        assert!(!record_sqlite_permanent_image_job_failure(
            &conn,
            &attempt_one,
            "img-a",
            &issue,
            "late error",
            Some(9),
        )
        .expect("late permanent failure"));
        assert!(get_sqlite_file_issue(&conn, root, "a.jpg")
            .expect("issue lookup")
            .is_none());
        let current = get_sqlite_job(&conn, &attempt_two.id)
            .expect("job")
            .expect("job row");
        assert_eq!(current.state, "running");
        assert_eq!(current.attempt, 2);
        assert_eq!(current.worker_id.as_deref(), Some("same-worker"));
        assert_eq!(
            list_sqlite_job_events(&conn, &attempt_one.id)
                .expect("events after")
                .len(),
            events_before
        );
    }

    #[test]
    fn file_deactivation_hides_image_cancels_jobs_and_deletes_issue_atomically() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let root = "/photos";
        upsert_fixture(&conn, "img-a", root, "bad.jpg", 10, 20);
        upsert_sqlite_file_issue(
            &conn,
            &SqliteFileIssueUpsert {
                image_id: Some("img-a".to_string()),
                root_path: root.to_string(),
                path: "bad.jpg".to_string(),
                severity: FileIssueSeverity::Error,
                kind: FileIssueKind::DecodeError,
                expected_format: Some(SupportedImageFormat::Jpeg),
                detected_format: None,
                size: 20,
                mtime_ns: 100,
                detail: None,
            },
        )
        .unwrap();
        let job = enqueue_sqlite_job(
            &conn,
            "thumb",
            json!({
                "image_id": "img-a",
                "root_path": root,
                "path": "bad.jpg",
                "thumb": ".imgindex/thumbs/img-a.jpg",
                "mtime": 10,
                "max_size": [640, 640],
            }),
            20,
            3,
            Some("thumb:img-a:10"),
        )
        .unwrap();
        let job_id = &job.job.id;

        conn.execute_batch(
            r#"
            CREATE TRIGGER reject_file_issue_delete
            BEFORE DELETE ON file_issues
            BEGIN
                SELECT RAISE(ABORT, 'reject issue delete');
            END;
            "#,
        )
        .unwrap();
        assert!(deactivate_sqlite_file_path(&conn, root, "bad.jpg").is_err());
        let hidden: i64 = conn
            .query_row("SELECT hidden FROM images WHERE id = 'img-a'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(hidden, 0, "image hide must roll back with issue delete");
        assert!(get_sqlite_file_issue(&conn, root, "bad.jpg")
            .unwrap()
            .is_some());
        assert_eq!(
            get_sqlite_job(&conn, job_id).unwrap().unwrap().state,
            "queued"
        );

        conn.execute_batch("DROP TRIGGER reject_file_issue_delete")
            .unwrap();
        let result = deactivate_sqlite_file_path(&conn, root, "bad.jpg").unwrap();
        assert!(result.image.is_some_and(|image| image.id == "img-a"));
        assert!(result.issue_deleted);
        let hidden: i64 = conn
            .query_row("SELECT hidden FROM images WHERE id = 'img-a'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(hidden, 1);
        assert!(get_sqlite_file_issue(&conn, root, "bad.jpg")
            .unwrap()
            .is_none());
        assert_eq!(
            get_sqlite_job(&conn, job_id).unwrap().unwrap().state,
            "canceled"
        );
        assert!(get_sqlite_image_by_id(&conn, "img-a").unwrap().is_none());
    }

    #[test]
    fn file_issue_path_helpers_follow_renames_and_deletes() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let root = "/photos";
        for path in ["old/a.jpg", "old/nested/b.png"] {
            upsert_sqlite_file_issue(
                &conn,
                &SqliteFileIssueUpsert {
                    image_id: None,
                    root_path: root.to_string(),
                    path: path.to_string(),
                    severity: FileIssueSeverity::Error,
                    kind: FileIssueKind::DecodeError,
                    expected_format: Some(if path.ends_with("png") {
                        SupportedImageFormat::Png
                    } else {
                        SupportedImageFormat::Jpeg
                    }),
                    detected_format: None,
                    size: 3,
                    mtime_ns: 4,
                    detail: None,
                },
            )
            .unwrap();
        }
        assert_eq!(
            rename_sqlite_file_issues_under_path(&conn, root, "old", "new").unwrap(),
            2
        );
        assert!(get_sqlite_file_issue(&conn, root, "old/a.jpg")
            .unwrap()
            .is_none());
        assert!(get_sqlite_file_issue(&conn, root, "new/a.jpg")
            .unwrap()
            .is_some());
        assert_eq!(
            delete_sqlite_file_issues_under_path(&conn, root, "new").unwrap(),
            2
        );
        assert!(list_sqlite_file_issues_for_root(&conn, root)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn live_path_helpers_preserve_ids_and_user_tags() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let root = "/photos";
        upsert_fixture(&conn, "img-a", root, "old/cat.jpg", 10, 10);
        upsert_fixture(&conn, "img-b", root, "old/nested/dog.png", 20, 20);
        upsert_fixture(&conn, "img-collision", root, "new/cat.webp", 30, 30);
        replace_sqlite_image_tags(&conn, "img-a", &["Favorite".to_string()], "user")
            .expect("user tag");
        let (thumb_job, _) = enqueue_sqlite_thumb_job(
            &conn,
            "img-a",
            root,
            "old/cat.jpg",
            ".imgindex/thumbs/img-a.jpg",
            10,
            20,
            3,
        )
        .expect("thumb job");
        let (collision_job, _) = enqueue_sqlite_thumb_job(
            &conn,
            "img-collision",
            root,
            "new/cat.webp",
            ".imgindex/thumbs/img-collision.jpg",
            30,
            20,
            3,
        )
        .expect("collision thumb job");

        let renamed = rename_sqlite_image_path(&conn, root, "old/cat.jpg", "new/cat.webp")
            .expect("rename image")
            .expect("renamed image");
        assert_eq!(
            retarget_sqlite_active_image_jobs(
                &conn,
                "img-a",
                root,
                "new/cat.webp",
                &renamed.thumb,
                renamed.mtime,
            )
            .expect("retarget jobs"),
            1
        );
        assert_eq!(renamed.id, "img-a");
        assert_eq!(renamed.path, "new/cat.webp");
        assert_eq!(renamed.ext, "webp");
        let (_, user_tags) = list_sqlite_tags_for_image(&conn, "img-a").expect("user tags");
        assert_eq!(user_tags, vec!["Favorite"]);
        let thumb_job = get_sqlite_job(&conn, thumb_job["id"].as_str().expect("thumb job id"))
            .expect("get thumb job")
            .expect("thumb job row");
        assert_eq!(thumb_job.payload["path"], "new/cat.webp");
        let collision_job = get_sqlite_job(
            &conn,
            collision_job["id"].as_str().expect("collision job id"),
        )
        .expect("get collision job")
        .expect("collision job row");
        assert_eq!(collision_job.state, "canceled");
        let collision: (String, i64) = conn
            .query_row(
                "SELECT path, hidden FROM images WHERE id = 'img-collision'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("hidden collision");
        assert!(collision.0.starts_with(".vilra-hidden/img-collision/"));
        assert_eq!(collision.1, 1);

        let moved = rename_sqlite_images_under_path(&conn, root, "old", "archive")
            .expect("rename directory");
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].id, "img-b");
        assert_eq!(moved[0].path, "archive/nested/dog.png");

        let hidden =
            hide_sqlite_images_under_path(&conn, root, "archive").expect("hide directory images");
        assert_eq!(hidden.len(), 1);
        assert!(get_sqlite_image_by_id(&conn, "img-b")
            .expect("visible lookup")
            .is_none());
        assert!(get_sqlite_image_by_root_path_including_hidden(
            &conn,
            root,
            "archive/nested/dog.png"
        )
        .expect("hidden lookup")
        .is_some_and(|image| image.hidden));

        let api_image = get_sqlite_image_api_value(&conn, "img-a")
            .expect("api image")
            .expect("visible api image");
        assert_eq!(api_image["id"], "img-a");
        assert_eq!(api_image["user_tags"][0], "Favorite");
    }

    #[test]
    fn tags_session_and_folder_helpers_match_runtime_shapes() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let root_dir = tempfile::tempdir().expect("root tempdir");
        let root = root_dir.path().to_string_lossy().to_string();
        upsert_fixture(&conn, "img-1", &root, "animals/cat.jpg", 10, 10);
        upsert_fixture(&conn, "img-2", &root, "zebra.jpg", 20, 20);

        let session = set_sqlite_session_root(&conn, root_dir.path(), true).expect("set root");
        assert_eq!(session.root_paths.len(), 1);
        let session = save_sqlite_session_value(
            &conn,
            &json!({
                "search_tags": [" Cat ", "cat"],
                "search_mode": "all",
                "tabs": [{"id": "tab-1"}],
                "active_tab_id": "tab-1",
            }),
        )
        .expect("save session");
        assert_eq!(session.search_tags, vec!["cat"]);
        assert_eq!(session.search_mode, "all");
        assert_eq!(session.tabs[0]["id"], "tab-1");

        create_sqlite_user_tag_entry(&conn, "Cat").expect("create user tag");
        attach_sqlite_tag_to_image(&conn, "img-1", "Cat", "user").expect("attach");
        replace_sqlite_image_tags(&conn, "img-1", &["Animals".to_string()], "auto")
            .expect("auto attach");
        let (auto, user) = list_sqlite_tags_for_image(&conn, "img-1").expect("tags");
        assert_eq!(auto, vec!["Animals"]);
        assert_eq!(user, vec!["Cat"]);

        let filtered = query_sqlite_images_page(
            &conn,
            &[root.clone()],
            SqliteImagesQuery {
                include_tags: Some("cat".to_string()),
                include_total: true,
                ..Default::default()
            },
        )
        .expect("tag filtered page");
        assert_eq!(filtered["page"]["total"], 1);
        assert_eq!(filtered["items"][0]["id"], "img-1");

        let summary = update_sqlite_tag_definition(&conn, "Cat", &json!({"color": "#aabbcc"}))
            .expect("tag color");
        assert_eq!(summary["color"], "#AABBCC");
        let renamed =
            update_sqlite_tag_definition(&conn, "Cat", &json!({"name": "Kitty"})).expect("rename");
        assert_eq!(renamed["normalized"], "kitty");
        assert_eq!(
            list_sqlite_images_by_tag(&conn, "kitty")
                .expect("by tag")
                .len(),
            1
        );

        detach_sqlite_tag_from_image(&conn, "img-1", "Kitty", Some("user")).expect("detach");
        let (_, user) = list_sqlite_tags_for_image(&conn, "img-1").expect("tags after detach");
        assert!(user.is_empty());

        delete_sqlite_tag_definition(&conn, "Animals").expect("delete auto tag");
        replace_sqlite_image_tags(&conn, "img-2", &["Animals".to_string()], "auto")
            .expect("suppressed auto attach");
        let (auto, _) = list_sqlite_tags_for_image(&conn, "img-2").expect("suppressed tags");
        assert!(auto.is_empty());

        let folders = folder_sqlite_tree_rows(&conn, &[root]).expect("folders");
        assert_eq!(folders[0]["path"], "animals/cat.jpg");
        assert_eq!(folders[1]["path"], "zebra.jpg");
    }

    #[test]
    fn folder_tag_sync_toggle_and_cleanup_preserve_user_tags() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        upsert_fixture(&conn, "img-1", "/photos", "folder/one.jpg", 10, 10);
        upsert_fixture(&conn, "img-2", "/photos", "other/two.jpg", 20, 20);

        replace_sqlite_image_tags(&conn, "img-1", &["Shared".to_string()], "auto")
            .expect("shared auto tag");
        replace_sqlite_image_tags(&conn, "img-1", &["Shared".to_string()], "user")
            .expect("shared user tag");
        replace_sqlite_image_tags(&conn, "img-2", &["Auto only".to_string()], "auto")
            .expect("auto-only tag");
        replace_sqlite_image_tags(&conn, "img-2", &["Favorite".to_string()], "user")
            .expect("user-only tag");

        assert!(sqlite_folder_tag_sync_enabled(&conn).expect("default setting"));
        set_sqlite_folder_tag_sync(&conn, false).expect("disable sync");
        assert!(!sqlite_folder_tag_sync_enabled(&conn).expect("disabled setting"));
        assert_eq!(
            list_sqlite_tags_for_image(&conn, "img-1").expect("tags while disabled"),
            (vec!["Shared".to_string()], vec!["Shared".to_string()])
        );

        let result = delete_all_sqlite_auto_tags(&conn).expect("delete auto tags");
        assert_eq!(result.assignments_removed, 2);
        assert_eq!(result.tags_removed, 1);
        assert_eq!(
            list_sqlite_tags_for_image(&conn, "img-1").expect("shared user tag remains"),
            (Vec::new(), vec!["Shared".to_string()])
        );
        assert_eq!(
            list_sqlite_tags_for_image(&conn, "img-2").expect("favorite remains"),
            (Vec::new(), vec!["Favorite".to_string()])
        );
        let summaries = tag_sqlite_summary_rows(&conn).expect("tag summaries");
        assert!(summaries.iter().any(|tag| {
            tag["normalized"] == "shared" && tag["source"] == "user" && tag["is_auto"] == false
        }));
        assert!(!summaries.iter().any(|tag| tag["normalized"] == "auto only"));
    }

    #[test]
    fn job_runtime_wrappers_work_after_normal_init() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        let queued =
            enqueue_sqlite_job(&conn, "index", json!({}), 0, 3, None).expect("index enqueue");
        let claimed = claim_next_sqlite_job(&conn, Some("index"), "worker-a")
            .expect("claim")
            .expect("claimed");
        touch_sqlite_job_progress(&conn, &claimed.id, 2, Some(5)).expect("progress");
        let api_job = get_sqlite_job_api_value(&conn, &claimed.id)
            .expect("job")
            .expect("job value");
        assert_eq!(api_job["progress"]["done"], 2);
        assert_eq!(api_job["progress"]["total"], 5);

        conn.execute(
            "UPDATE jobs SET updated_at = '2026-01-01T00:00:00.000Z', started_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            [&claimed.id],
        )
        .expect("make stale");
        assert_eq!(
            count_sqlite_stale_running_jobs(&conn, Some("index"), 300).expect("stale count"),
            1
        );
        let recovered = recover_sqlite_stale_running_jobs(&conn, 300, 10).expect("recover");
        assert_eq!(recovered.requeued, 1);
        let claimed = claim_next_sqlite_job(&conn, Some("index"), "worker-b")
            .expect("claim again")
            .expect("claimed again");
        mark_sqlite_job_succeeded(&conn, &claimed.id, Some(5), None).expect("success");
        let events = list_sqlite_job_events(&conn, &claimed.id).expect("events");
        assert!(events.iter().any(|event| event.event == "recovered"));
        assert!(events.iter().any(|event| event.event == "succeeded"));

        let (thumb, deduped) = enqueue_sqlite_thumb_job(
            &conn,
            "img-1",
            "/photos",
            "cat.jpg",
            ".imgindex/thumbs/img-1.jpg",
            123,
            20,
            5,
        )
        .expect("thumb enqueue");
        assert!(!deduped);
        let (_, deduped) = enqueue_sqlite_thumb_job(
            &conn,
            "img-1",
            "/photos",
            "cat.jpg",
            ".imgindex/thumbs/img-1.jpg",
            123,
            30,
            5,
        )
        .expect("thumb dedupe");
        assert!(deduped);
        let promoted = get_sqlite_job(
            &conn,
            thumb["id"].as_str().expect("promoted thumbnail job id"),
        )
        .expect("read promoted thumbnail job")
        .expect("promoted thumbnail job");
        assert_eq!(promoted.priority, 30);
        let enqueued_events = list_sqlite_job_events(&conn, &promoted.id)
            .expect("thumbnail events")
            .into_iter()
            .filter(|event| event.event == "enqueued")
            .count();
        assert_eq!(enqueued_events, 1);
        assert!(cancel_sqlite_job(&conn, thumb["id"].as_str().expect("thumb id")).expect("cancel"));

        conn.execute(
            "UPDATE jobs SET finished_at = '2026-01-01T00:00:00.000Z' WHERE state = 'canceled'",
            [],
        )
        .expect("old finish");
        let cleanup = cleanup_sqlite_old_jobs(&conn, 1).expect("cleanup");
        assert_eq!(cleanup.removed_jobs, 1);

        let jobs = list_sqlite_jobs(&conn, None, None, 10).expect("list jobs");
        assert!(jobs.iter().any(|job| job["id"] == queued.job.id));
    }

    #[test]
    fn metadata_wrappers_write_expected_events() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        enqueue_sqlite_metadata_job(&conn, "img-1", "/photos", "a.jpg", Some(5), 0, 1)
            .expect("metadata enqueue");
        let metadata = claim_next_sqlite_metadata_job(&conn, "metadata-worker")
            .expect("metadata claim")
            .expect("metadata job");
        mark_sqlite_metadata_succeeded(
            &conn,
            &metadata,
            json!({"image_id": "img-1", "width": 10}),
            true,
        )
        .expect("metadata success");
        let metadata_events = list_sqlite_job_events(&conn, &metadata.id).expect("metadata events");
        let success = metadata_events
            .iter()
            .find(|event| event.event == "succeeded")
            .expect("metadata success event");
        assert_eq!(success.data["metadata"]["image_id"], "img-1");
        assert_eq!(success.data["authoritative"], true);
        assert_eq!(success.data["shadow"], false);

        enqueue_sqlite_job(&conn, "metadata", json!({"image_id": "img-2"}), 0, 1, None)
            .expect("metadata failure enqueue");
        let failed = claim_next_sqlite_metadata_job(&conn, "metadata-worker")
            .expect("metadata fail claim")
            .expect("metadata fail job");
        mark_sqlite_metadata_failed(&conn, &failed, "boom", Some(12), 120).expect("metadata fail");
        let failed_value = get_sqlite_job_api_value(&conn, &failed.id)
            .expect("failed job")
            .expect("failed job");
        assert_eq!(failed_value["state"], "failed");
        assert_eq!(failed_value["error"], "boom");
    }

    #[test]
    fn source_row_helpers_and_metadata_enqueue_do_not_touch_filesystem() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        upsert_fixture(&conn, "img-a", "/photos", "a.jpg", 100, 10);
        upsert_fixture(&conn, "img-b", "/photos", "b.jpg", 200, 20);

        let thumbs = list_sqlite_thumb_rebuild_rows(&conn, &["/photos".to_string()], Some(1))
            .expect("thumb rows");
        assert_eq!(thumbs.len(), 1);
        assert_eq!(thumbs[0].id, "img-a");

        let metadata = list_sqlite_metadata_source_rows(&conn, None).expect("metadata rows");
        assert_eq!(metadata.len(), 2);

        let (job, deduped) =
            enqueue_sqlite_metadata_job(&conn, "img-a", "/photos", "a.jpg", Some(100), 10, 3)
                .expect("metadata enqueue");
        assert!(!deduped);
        assert_eq!(job["payload"]["image_id"], "img-a");
        let (_, deduped) =
            enqueue_sqlite_metadata_job(&conn, "img-a", "/photos", "a.jpg", Some(100), 10, 3)
                .expect("metadata dedupe");
        assert!(deduped);

        let jobs_before = count_sqlite_jobs(&conn, None, None).expect("job count");
        assert!(enqueue_sqlite_thumb_job(
            &conn,
            "img-a",
            "/photos",
            "extensionless",
            ".imgindex/thumbs/img-a.jpg",
            100,
            10,
            3,
        )
        .is_err());
        assert!(enqueue_sqlite_metadata_job(
            &conn,
            "img-a",
            "/photos",
            "image.gif",
            Some(100),
            10,
            3,
        )
        .is_err());
        assert_eq!(
            count_sqlite_jobs(&conn, None, None).expect("job count after invalid paths"),
            jobs_before
        );
    }

    #[test]
    fn file_issue_summary_query_search_pagination_and_ordering() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        for (path, severity, kind) in [
            (
                "zeta/broken.jpg",
                FileIssueSeverity::Error,
                FileIssueKind::DecodeError,
            ),
            (
                "Alpha/mismatch.jpg",
                FileIssueSeverity::Warning,
                FileIssueKind::FormatMismatch,
            ),
            (
                "beta/unsupported.png",
                FileIssueSeverity::Error,
                FileIssueKind::UnsupportedContent,
            ),
        ] {
            upsert_sqlite_file_issue(
                &conn,
                &SqliteFileIssueUpsert {
                    image_id: None,
                    root_path: "/photos".to_string(),
                    path: path.to_string(),
                    severity,
                    kind,
                    expected_format: expected_format_for_path(Path::new(path)),
                    detected_format: None,
                    size: 10,
                    mtime_ns: 20,
                    detail: Some("fixture".to_string()),
                },
            )
            .expect("insert issue");
        }

        let summary = summarize_sqlite_file_issues(&conn).expect("summary");
        assert_eq!((summary.total, summary.errors, summary.warnings), (3, 2, 1));
        assert!(summary.latest_updated_at.is_some());

        let first = query_sqlite_file_issues(&conn, "all", "", 2, 0).expect("first page");
        assert_eq!(first.total, 3);
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.items[0].path, "beta/unsupported.png");
        assert_eq!(first.items[1].path, "zeta/broken.jpg");
        let second = query_sqlite_file_issues(&conn, "all", "", 2, 2).expect("second page");
        assert_eq!(second.items[0].path, "Alpha/mismatch.jpg");

        let searched =
            query_sqlite_file_issues(&conn, "warning", "MISMATCH", 10, 0).expect("search");
        assert_eq!(searched.total, 1);
        let issue = get_sqlite_file_issue_by_id(&conn, searched.items[0].id)
            .expect("get by id")
            .expect("issue");
        assert_eq!(issue.path, "Alpha/mismatch.jpg");

        let targets = list_sqlite_file_issue_recheck_targets(&conn).expect("targets");
        assert_eq!(targets.len(), 3);
    }
}

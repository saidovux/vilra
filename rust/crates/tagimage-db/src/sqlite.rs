use crate::sqlite_schema::{INDEX_STATEMENTS, SQLITE_SCHEMA_VERSION, TABLE_STATEMENTS};
use crate::ClaimedJob;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;
use uuid::Uuid;

pub use crate::sqlite_runtime::*;

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteJob {
    pub id: String,
    pub job_type: String,
    pub payload: Value,
    pub dedupe_key: Option<String>,
    pub state: String,
    pub priority: i32,
    pub attempt: i32,
    pub max_attempts: i32,
    pub progress_done: i32,
    pub progress_total: i32,
    pub error: Option<String>,
    pub worker_id: Option<String>,
    pub scheduled_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteJobEvent {
    pub id: i64,
    pub job_id: String,
    pub event: String,
    pub data: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SqliteEnqueueResult {
    pub job: SqliteJob,
    pub deduped: bool,
}

pub fn init_sqlite_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create sqlite parent dir {}: {e}", parent.display()))?;
        }
    }

    let mut conn =
        Connection::open(path).map_err(|e| format!("open sqlite db {}: {e}", path.display()))?;

    conn.busy_timeout(Duration::from_millis(5_000))
        .map_err(|e| format!("set sqlite busy_timeout: {e}"))?;
    conn.execute_batch(
        r#"
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        "#,
    )
    .map_err(|e| format!("set sqlite pragmas: {e}"))?;

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("begin sqlite schema tx: {e}"))?;
    for statement in TABLE_STATEMENTS {
        tx.execute_batch(statement)
            .map_err(|e| format!("create sqlite table: {e}"))?;
    }
    for statement in INDEX_STATEMENTS {
        tx.execute_batch(statement)
            .map_err(|e| format!("create sqlite index: {e}"))?;
    }
    tx.execute(
        r#"
        INSERT INTO tagimage_schema_version (id, version)
        VALUES (1, ?1)
        ON CONFLICT(id) DO NOTHING
        "#,
        [SQLITE_SCHEMA_VERSION],
    )
    .map_err(|e| format!("record sqlite schema version: {e}"))?;

    let version = tx
        .query_row(
            "SELECT version FROM tagimage_schema_version WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| format!("read sqlite schema version: {e}"))?;
    if version != SQLITE_SCHEMA_VERSION {
        return Err(format!(
            "unsupported sqlite schema version {version}; expected {SQLITE_SCHEMA_VERSION}"
        ));
    }

    tx.commit()
        .map_err(|e| format!("commit sqlite schema tx: {e}"))?;
    Ok(conn)
}

pub fn enqueue_sqlite_job(
    conn: &Connection,
    job_type: &str,
    payload: Value,
    priority: i32,
    max_attempts: i32,
    dedupe_key: Option<&str>,
) -> Result<SqliteEnqueueResult, String> {
    with_immediate_tx(conn, || {
        if let Some(dedupe_key) = dedupe_key {
            if let Some(existing) = find_active_job_by_dedupe(conn, job_type, dedupe_key)
                .map_err(|e| format!("find sqlite active dedupe job type={job_type}: {e}"))?
            {
                return Ok(SqliteEnqueueResult {
                    job: existing,
                    deduped: true,
                });
            }
        }

        let job_id = Uuid::new_v4().simple().to_string();
        let payload_text =
            serde_json::to_string(&payload).map_err(|e| format!("serialize job payload: {e}"))?;
        let dedupe_key_owned = dedupe_key.map(str::to_string);
        conn.execute(
            r#"
            INSERT INTO jobs (
                id, job_type, payload, state, priority, max_attempts, scheduled_at, dedupe_key
            )
            VALUES (
                ?1, ?2, ?3, 'queued', ?4, max(1, ?5),
                strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?6
            )
            "#,
            params![
                job_id,
                job_type,
                payload_text,
                priority,
                max_attempts,
                dedupe_key_owned,
            ],
        )
        .map_err(|e| format!("insert sqlite job: {e}"))?;
        insert_job_event(conn, &job_id, "enqueued", json!({"job_type": job_type}))?;

        let job = get_sqlite_job(conn, &job_id)?
            .ok_or_else(|| format!("inserted sqlite job not found: {job_id}"))?;
        Ok(SqliteEnqueueResult {
            job,
            deduped: false,
        })
    })
}

pub fn claim_next_sqlite_job(
    conn: &Connection,
    job_type: Option<&str>,
    worker_id: &str,
) -> Result<Option<ClaimedJob>, String> {
    with_immediate_tx(conn, || {
        let row = if let Some(job_type) = job_type {
            conn.query_row(
                r#"
                UPDATE jobs
                SET state = 'running',
                    worker_id = ?1,
                    started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    attempt = attempt + 1,
                    error = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = (
                    SELECT id
                    FROM jobs
                    WHERE state = 'queued'
                      AND scheduled_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                      AND job_type = ?2
                    ORDER BY priority DESC, scheduled_at, created_at
                    LIMIT 1
                )
                RETURNING id, attempt, max_attempts, payload
                "#,
                params![worker_id, job_type],
                claimed_job_from_row,
            )
            .optional()
        } else {
            conn.query_row(
                r#"
                UPDATE jobs
                SET state = 'running',
                    worker_id = ?1,
                    started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    attempt = attempt + 1,
                    error = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = (
                    SELECT id
                    FROM jobs
                    WHERE state = 'queued'
                      AND scheduled_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    ORDER BY priority DESC, scheduled_at, created_at
                    LIMIT 1
                )
                RETURNING id, attempt, max_attempts, payload
                "#,
                params![worker_id],
                claimed_job_from_row,
            )
            .optional()
        }
        .map_err(|e| format!("claim sqlite job: {e}"))?;

        let Some(job) = row else {
            return Ok(None);
        };

        conn.execute(
            "INSERT INTO job_attempts (job_id, attempt, worker_id, state) VALUES (?1, ?2, ?3, 'running')",
            params![job.id, job.attempt, worker_id],
        )
        .map_err(|e| format!("insert sqlite job attempt: {e}"))?;
        insert_job_event(
            conn,
            &job.id,
            "started",
            json!({"attempt": job.attempt, "worker_id": worker_id, "claimed_at": now_unix()}),
        )?;

        Ok(Some(job))
    })
}

pub fn mark_sqlite_job_succeeded(
    conn: &Connection,
    job_id: &str,
    total: Option<i32>,
    event_data: Option<Value>,
) -> Result<(), String> {
    with_immediate_tx(conn, || {
        let current = get_sqlite_job(conn, job_id)?
            .ok_or_else(|| format!("sqlite job not found for success: {job_id}"))?;
        let resolved_total = total.unwrap_or_else(|| {
            if current.progress_total > 0 {
                current.progress_total
            } else {
                current.progress_done
            }
        });

        if let Some(total) = total {
            conn.execute(
                r#"
                UPDATE jobs
                SET state = 'succeeded',
                    progress_done = max(0, ?2),
                    progress_total = max(0, ?2),
                    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    error = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
                params![job_id, total],
            )
        } else {
            conn.execute(
                r#"
                UPDATE jobs
                SET state = 'succeeded',
                    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    error = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
                params![job_id],
            )
        }
        .map_err(|e| format!("update sqlite job succeeded: {e}"))?;

        set_latest_attempt_state(conn, job_id, "succeeded", None)?;
        insert_job_event(
            conn,
            job_id,
            "succeeded",
            event_data.unwrap_or_else(|| json!({"total": resolved_total})),
        )
    })
}

pub fn mark_sqlite_job_failed(
    conn: &Connection,
    job_id: &str,
    error: &str,
    max_backoff_sec: i64,
    total_ms: Option<u128>,
) -> Result<(), String> {
    with_immediate_tx(conn, || {
        let job = get_sqlite_job(conn, job_id)?
            .ok_or_else(|| format!("sqlite job not found for failure: {job_id}"))?;
        let retries_left = (job.max_attempts - job.attempt).max(0);
        let (next_state, event_name, backoff) = if retries_left > 0 {
            let secs = 2_i64
                .pow(job.attempt.max(1) as u32)
                .min(max_backoff_sec.max(1));
            ("queued", "retry_scheduled", secs)
        } else {
            ("failed", "failed", 0)
        };

        if next_state == "queued" {
            conn.execute(
                r#"
                UPDATE jobs
                SET state = 'queued',
                    error = ?2,
                    scheduled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?3)),
                    worker_id = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
                params![job_id, error, backoff],
            )
        } else {
            conn.execute(
                r#"
                UPDATE jobs
                SET state = 'failed',
                    error = ?2,
                    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?1
                "#,
                params![job_id, error],
            )
        }
        .map_err(|e| format!("update sqlite job failed: {e}"))?;

        set_latest_attempt_state(conn, job_id, next_state, Some(error))?;
        insert_job_event(
            conn,
            job_id,
            event_name,
            json!({
                "error": error,
                "attempt": job.attempt,
                "max_attempts": job.max_attempts,
                "next_state": next_state,
                "backoff": backoff,
                "total_ms": total_ms.map(ms_to_u64),
            }),
        )
    })
}

pub fn get_sqlite_job(conn: &Connection, job_id: &str) -> Result<Option<SqliteJob>, String> {
    conn.query_row(
        "SELECT * FROM jobs WHERE id = ?1",
        params![job_id],
        sqlite_job_from_row,
    )
    .optional()
    .map_err(|e| format!("get sqlite job {job_id}: {e}"))
}

pub fn list_sqlite_job_events(
    conn: &Connection,
    job_id: &str,
) -> Result<Vec<SqliteJobEvent>, String> {
    let mut stmt = conn
        .prepare(
            r#"
            SELECT id, job_id, event, data, created_at
            FROM job_events
            WHERE job_id = ?1
            ORDER BY id
            "#,
        )
        .map_err(|e| format!("prepare sqlite job events query: {e}"))?;
    let rows = stmt
        .query_map(params![job_id], sqlite_job_event_from_row)
        .map_err(|e| format!("query sqlite job events: {e}"))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|e| format!("read sqlite job event row: {e}"))?);
    }
    Ok(events)
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

fn find_active_job_by_dedupe(
    conn: &Connection,
    job_type: &str,
    dedupe_key: &str,
) -> rusqlite::Result<Option<SqliteJob>> {
    conn.query_row(
        r#"
        SELECT *
        FROM jobs
        WHERE job_type = ?1
          AND dedupe_key = ?2
          AND state IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1
        "#,
        params![job_type, dedupe_key],
        sqlite_job_from_row,
    )
    .optional()
}

fn insert_job_event(
    conn: &Connection,
    job_id: &str,
    event: &str,
    data: Value,
) -> Result<(), String> {
    let data_text =
        serde_json::to_string(&data).map_err(|e| format!("serialize job event data: {e}"))?;
    conn.execute(
        "INSERT INTO job_events (job_id, event, data) VALUES (?1, ?2, ?3)",
        params![job_id, event, data_text],
    )
    .map_err(|e| format!("insert sqlite job event {event}: {e}"))?;
    Ok(())
}

fn set_latest_attempt_state(
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
    .map_err(|e| format!("update sqlite latest job attempt: {e}"))?;
    Ok(())
}

fn claimed_job_from_row(row: &Row<'_>) -> rusqlite::Result<ClaimedJob> {
    let payload_text: String = row.get("payload")?;
    let payload = parse_json_text(payload_text);
    Ok(ClaimedJob {
        id: row.get("id")?,
        attempt: row.get("attempt")?,
        max_attempts: row.get("max_attempts")?,
        payload,
    })
}

fn sqlite_job_from_row(row: &Row<'_>) -> rusqlite::Result<SqliteJob> {
    let payload_text: String = row.get("payload")?;
    Ok(SqliteJob {
        id: row.get("id")?,
        job_type: row.get("job_type")?,
        payload: parse_json_text(payload_text),
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

fn sqlite_job_event_from_row(row: &Row<'_>) -> rusqlite::Result<SqliteJobEvent> {
    let data_text: String = row.get("data")?;
    Ok(SqliteJobEvent {
        id: row.get("id")?,
        job_id: row.get("job_id")?,
        event: row.get("event")?,
        data: parse_json_text(data_text),
        created_at: row.get("created_at")?,
    })
}

fn parse_json_text(text: String) -> Value {
    serde_json::from_str(&text).unwrap_or_else(|_| json!({}))
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn ms_to_u64(value: u128) -> u64 {
    value.min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::{
        claim_next_sqlite_job, enqueue_sqlite_job, get_sqlite_job, init_sqlite_db,
        list_sqlite_job_events, mark_sqlite_job_failed, mark_sqlite_job_succeeded,
    };
    use crate::sqlite_schema::SQLITE_SCHEMA_VERSION;
    use rusqlite::Connection;
    use serde_json::{json, Value};
    use std::collections::{HashSet, VecDeque};
    use std::sync::{Arc, Mutex};
    use std::thread;

    fn temp_db_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("tagimage.sqlite");
        (dir, db_path)
    }

    fn names(conn: &Connection, sql: &str) -> HashSet<String> {
        let mut stmt = conn.prepare(sql).expect("prepare names query");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query names");
        rows.map(|row| row.expect("name row")).collect()
    }

    fn event_names(conn: &Connection, job_id: &str) -> Vec<String> {
        list_sqlite_job_events(conn, job_id)
            .expect("list events")
            .into_iter()
            .map(|event| event.event)
            .collect()
    }

    fn event_count(conn: &Connection, job_id: &str, event: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM job_events WHERE job_id = ?1 AND event = ?2",
            [job_id, event],
            |row| row.get(0),
        )
        .expect("event count")
    }

    fn payload(name: &str) -> Value {
        json!({"name": name})
    }

    #[test]
    fn init_creates_schema_and_is_idempotent() {
        let (_dir, db_path) = temp_db_path();

        let conn = init_sqlite_db(&db_path).expect("first init");
        drop(conn);
        let conn = init_sqlite_db(&db_path).expect("second init");

        let tables = names(
            &conn,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        );
        for expected in [
            "tagimage_schema_version",
            "images",
            "tags",
            "suppressed_auto_tags",
            "image_tags",
            "app_session",
            "jobs",
            "job_attempts",
            "job_events",
        ] {
            assert!(tables.contains(expected), "missing table {expected}");
        }

        let version: i64 = conn
            .query_row(
                "SELECT version FROM tagimage_schema_version WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("schema version");
        assert_eq!(version, SQLITE_SCHEMA_VERSION);
    }

    #[test]
    fn init_creates_required_indexes() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        let indexes = names(
            &conn,
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
        );
        for expected in [
            "images_root_path_idx",
            "images_root_hidden_idx",
            "images_root_hidden_sort_idx",
            "images_root_hidden_mtime_idx",
            "images_root_hidden_size_idx",
            "tags_name_idx",
            "tags_normalized_idx",
            "image_tags_image_idx",
            "image_tags_image_kind_idx",
            "image_tags_tag_idx",
            "image_tags_tag_kind_idx",
            "jobs_queue_lookup_idx",
            "jobs_type_state_idx",
            "jobs_type_state_scheduled_idx",
            "jobs_active_dedupe_idx",
            "job_attempts_job_id_idx",
            "job_events_job_id_idx",
        ] {
            assert!(indexes.contains(expected), "missing index {expected}");
        }
    }

    #[test]
    fn init_sets_required_pragmas() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        let enabled: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .expect("foreign_keys pragma");
        assert_eq!(enabled, 1);

        let timeout_ms: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .expect("busy_timeout pragma");
        assert_eq!(timeout_ms, 5_000);
    }

    #[test]
    fn basic_insert_select_works_for_index_tables() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        conn.execute(
            r#"
            INSERT INTO app_session (id, root_path, root_paths, search_tags, tabs)
            VALUES (1, ?1, ?2, ?3, ?4)
            "#,
            [
                "/photos",
                r#"["/photos"]"#,
                r#"["portrait"]"#,
                r#"[{"id":"tab-1"}]"#,
            ],
        )
        .expect("insert app_session");

        conn.execute(
            r#"
            INSERT INTO images (id, root_path, path, thumb, size, mtime, width, height, ext)
            VALUES ('img-1', '/photos', 'a/cat.jpg', '.imgindex/thumbs/img-1.jpg', 123, 456, 640, 480, 'jpg')
            "#,
            [],
        )
        .expect("insert image");

        conn.execute(
            "INSERT INTO tags (name, normalized, user_defined) VALUES ('Cat', 'cat', 1)",
            [],
        )
        .expect("insert tag");
        let tag_id = conn.last_insert_rowid();

        conn.execute(
            "INSERT INTO image_tags (image_id, tag_id, kind) VALUES ('img-1', ?1, 'user')",
            [tag_id],
        )
        .expect("insert image tag");

        conn.execute(
            r#"
            INSERT INTO jobs (id, job_type, payload, state, priority, dedupe_key)
            VALUES ('job-1', 'thumb', ?1, 'queued', 20, 'thumb:img-1:456')
            "#,
            [r#"{"image_id":"img-1"}"#],
        )
        .expect("insert job");

        conn.execute(
            "INSERT INTO job_attempts (job_id, attempt, worker_id, state) VALUES ('job-1', 1, 'worker-1', 'running')",
            [],
        )
        .expect("insert job attempt");
        conn.execute(
            "INSERT INTO job_events (job_id, event, data) VALUES ('job-1', 'enqueued', ?1)",
            [r#"{"job_type":"thumb"}"#],
        )
        .expect("insert job event");

        let image_count: i64 = conn
            .query_row(
                r#"
                SELECT COUNT(*)
                FROM images i
                JOIN image_tags it ON it.image_id = i.id
                JOIN tags t ON t.id = it.tag_id
                WHERE i.root_path = '/photos'
                  AND i.path = 'a/cat.jpg'
                  AND i.thumb = '.imgindex/thumbs/img-1.jpg'
                  AND i.ext = 'jpg'
                  AND t.normalized = 'cat'
                "#,
                [],
                |row| row.get(0),
            )
            .expect("select image/tag");
        assert_eq!(image_count, 1);

        let job_count: i64 = conn
            .query_row(
                r#"
                SELECT COUNT(*)
                FROM jobs j
                JOIN job_attempts ja ON ja.job_id = j.id
                JOIN job_events je ON je.job_id = j.id
                WHERE j.id = 'job-1'
                  AND j.job_type = 'thumb'
                  AND j.state = 'queued'
                  AND ja.attempt = 1
                  AND je.event = 'enqueued'
                "#,
                [],
                |row| row.get(0),
            )
            .expect("select job graph");
        assert_eq!(job_count, 1);

        let root_paths: String = conn
            .query_row(
                "SELECT root_paths FROM app_session WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .expect("select root paths");
        assert_eq!(root_paths, r#"["/photos"]"#);
    }

    #[test]
    fn schema_has_no_media_blob_columns() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        let mut stmt = conn
            .prepare(
                r#"
                SELECT m.name, p.name, p.type
                FROM sqlite_master m
                JOIN pragma_table_info(m.name) p
                WHERE m.type = 'table'
                "#,
            )
            .expect("prepare schema query");
        let columns = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .expect("query columns");

        for column in columns {
            let (table, name, column_type) = column.expect("column row");
            assert!(
                !column_type.eq_ignore_ascii_case("BLOB"),
                "{table}.{name} must not be BLOB"
            );
            let lowered = name.to_ascii_lowercase();
            assert!(
                !matches!(
                    lowered.as_str(),
                    "original"
                        | "original_blob"
                        | "original_bytes"
                        | "image_blob"
                        | "image_bytes"
                        | "thumbnail_blob"
                        | "thumbnail_bytes"
                        | "thumb_blob"
                        | "thumb_bytes"
                        | "preview_blob"
                        | "preview_bytes"
                ),
                "{table}.{name} looks like media content storage"
            );
        }
    }

    #[test]
    fn enqueue_creates_job_and_enqueued_event() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        let result =
            enqueue_sqlite_job(&conn, "thumb", payload("first"), 20, 0, None).expect("enqueue");

        assert!(!result.deduped);
        assert_eq!(result.job.job_type, "thumb");
        assert_eq!(result.job.state, "queued");
        assert_eq!(result.job.priority, 20);
        assert_eq!(result.job.max_attempts, 1);
        assert_eq!(result.job.payload["name"], "first");

        let events = list_sqlite_job_events(&conn, &result.job.id).expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event, "enqueued");
        assert_eq!(events[0].data["job_type"], "thumb");
    }

    #[test]
    fn active_dedupe_returns_existing_job_without_duplicate_enqueue_event() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        let first = enqueue_sqlite_job(
            &conn,
            "thumb",
            payload("dedupe"),
            10,
            3,
            Some("thumb:img:1"),
        )
        .expect("first enqueue");
        let second = enqueue_sqlite_job(
            &conn,
            "thumb",
            payload("dedupe-new"),
            10,
            3,
            Some("thumb:img:1"),
        )
        .expect("second enqueue");

        assert!(second.deduped);
        assert_eq!(second.job.id, first.job.id);
        assert_eq!(event_count(&conn, &first.job.id, "enqueued"), 1);

        let claimed = claim_next_sqlite_job(&conn, Some("thumb"), "worker-a")
            .expect("claim")
            .expect("claimed");
        assert_eq!(claimed.id, first.job.id);

        let third = enqueue_sqlite_job(
            &conn,
            "thumb",
            payload("dedupe-running"),
            10,
            3,
            Some("thumb:img:1"),
        )
        .expect("third enqueue");
        assert!(third.deduped);
        assert_eq!(third.job.id, first.job.id);
        assert_eq!(event_count(&conn, &first.job.id, "enqueued"), 1);
    }

    #[test]
    fn dedupe_key_can_enqueue_again_after_success() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        let first =
            enqueue_sqlite_job(&conn, "thumb", payload("first"), 10, 3, Some("thumb:img:2"))
                .expect("first enqueue");
        let claimed = claim_next_sqlite_job(&conn, Some("thumb"), "worker-a")
            .expect("claim")
            .expect("claimed");
        mark_sqlite_job_succeeded(&conn, &claimed.id, Some(1), None).expect("success");

        let second = enqueue_sqlite_job(
            &conn,
            "thumb",
            payload("second"),
            10,
            3,
            Some("thumb:img:2"),
        )
        .expect("second enqueue");

        assert!(!second.deduped);
        assert_ne!(second.job.id, first.job.id);
        assert_eq!(event_count(&conn, &first.job.id, "enqueued"), 1);
        assert_eq!(event_count(&conn, &second.job.id, "enqueued"), 1);
    }

    #[test]
    fn claim_respects_type_schedule_priority_and_fifo_order() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");

        let future = enqueue_sqlite_job(&conn, "thumb", payload("future"), 100, 3, None)
            .expect("future enqueue");
        conn.execute(
            "UPDATE jobs SET scheduled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour') WHERE id = ?1",
            [&future.job.id],
        )
        .expect("schedule future");

        let ignored_type = enqueue_sqlite_job(&conn, "metadata", payload("metadata"), 200, 3, None)
            .expect("metadata enqueue");
        let older = enqueue_sqlite_job(&conn, "thumb", payload("older"), 50, 3, None)
            .expect("older enqueue");
        let newer = enqueue_sqlite_job(&conn, "thumb", payload("newer"), 50, 3, None)
            .expect("newer enqueue");
        let high =
            enqueue_sqlite_job(&conn, "thumb", payload("high"), 90, 3, None).expect("high enqueue");

        conn.execute(
            "UPDATE jobs SET created_at = '2026-01-01T00:00:00.000Z', scheduled_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            [&older.job.id],
        )
        .expect("older timestamps");
        conn.execute(
            "UPDATE jobs SET created_at = '2026-01-01T00:00:01.000Z', scheduled_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            [&newer.job.id],
        )
        .expect("newer timestamps");
        conn.execute(
            "UPDATE jobs SET created_at = '2026-01-01T00:00:02.000Z', scheduled_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            [&high.job.id],
        )
        .expect("high timestamps");

        let first = claim_next_sqlite_job(&conn, Some("thumb"), "worker-a")
            .expect("claim first")
            .expect("first");
        let second = claim_next_sqlite_job(&conn, Some("thumb"), "worker-b")
            .expect("claim second")
            .expect("second");
        let third = claim_next_sqlite_job(&conn, Some("thumb"), "worker-c")
            .expect("claim third")
            .expect("third");

        assert_eq!(first.id, high.job.id);
        assert_eq!(second.id, older.job.id);
        assert_eq!(third.id, newer.job.id);
        assert!(claim_next_sqlite_job(&conn, Some("thumb"), "worker-d")
            .expect("claim none")
            .is_none());

        let metadata = get_sqlite_job(&conn, &ignored_type.job.id)
            .expect("metadata")
            .expect("metadata job");
        let future = get_sqlite_job(&conn, &future.job.id)
            .expect("future")
            .expect("future job");
        assert_eq!(metadata.state, "queued");
        assert_eq!(future.state, "queued");
    }

    #[test]
    fn claim_creates_attempt_and_started_event() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let enqueued =
            enqueue_sqlite_job(&conn, "thumb", payload("claim"), 10, 3, None).expect("enqueue");

        let claimed = claim_next_sqlite_job(&conn, Some("thumb"), "worker-a")
            .expect("claim")
            .expect("claimed");

        assert_eq!(claimed.id, enqueued.job.id);
        assert_eq!(claimed.attempt, 1);
        assert_eq!(claimed.payload["name"], "claim");

        let attempt_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM job_attempts WHERE job_id = ?1 AND attempt = 1 AND worker_id = 'worker-a' AND state = 'running'",
                [&claimed.id],
                |row| row.get(0),
            )
            .expect("attempt count");
        assert_eq!(attempt_count, 1);

        let events = list_sqlite_job_events(&conn, &claimed.id).expect("events");
        assert_eq!(events[0].event, "enqueued");
        assert_eq!(events[1].event, "started");
        assert_eq!(events[1].data["worker_id"], "worker-a");
    }

    #[test]
    fn concurrent_claims_never_return_duplicate_jobs() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let mut expected = HashSet::new();
        for index in 0..12 {
            let job = enqueue_sqlite_job(
                &conn,
                "thumb",
                payload(&format!("job-{index}")),
                10,
                3,
                None,
            )
            .expect("enqueue");
            expected.insert(job.job.id);
        }
        drop(conn);

        let results = Arc::new(Mutex::new(Vec::new()));
        let connections = (0..6)
            .map(|_| init_sqlite_db(&db_path).expect("thread connection init"))
            .collect::<Vec<_>>();
        let mut handles = Vec::new();
        for (worker_index, conn) in connections.into_iter().enumerate() {
            let results = Arc::clone(&results);
            handles.push(thread::spawn(move || loop {
                let claimed =
                    claim_next_sqlite_job(&conn, Some("thumb"), &format!("worker-{worker_index}"))
                        .expect("thread claim");
                let Some(job) = claimed else {
                    break;
                };
                results.lock().expect("lock results").push(job.id);
            }));
        }
        for handle in handles {
            handle.join().expect("join worker");
        }

        let claimed = results.lock().expect("lock final");
        let unique = claimed.iter().cloned().collect::<HashSet<_>>();
        assert_eq!(claimed.len(), 12);
        assert_eq!(unique.len(), 12);
        assert_eq!(unique, expected);
    }

    #[test]
    fn success_updates_job_latest_attempt_and_event() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let enqueued =
            enqueue_sqlite_job(&conn, "thumb", payload("success"), 10, 3, None).expect("enqueue");
        let claimed = claim_next_sqlite_job(&conn, Some("thumb"), "worker-a")
            .expect("claim")
            .expect("claimed");

        mark_sqlite_job_succeeded(
            &conn,
            &claimed.id,
            Some(7),
            Some(json!({"custom": true, "total": 7})),
        )
        .expect("success");

        let job = get_sqlite_job(&conn, &enqueued.job.id)
            .expect("job")
            .expect("job row");
        assert_eq!(job.state, "succeeded");
        assert_eq!(job.progress_done, 7);
        assert_eq!(job.progress_total, 7);
        assert!(job.finished_at.is_some());
        assert!(job.error.is_none());

        let attempt_state: String = conn
            .query_row(
                "SELECT state FROM job_attempts WHERE job_id = ?1 ORDER BY id DESC LIMIT 1",
                [&job.id],
                |row| row.get(0),
            )
            .expect("attempt state");
        assert_eq!(attempt_state, "succeeded");

        let events = list_sqlite_job_events(&conn, &job.id).expect("events");
        assert_eq!(events.last().expect("last event").event, "succeeded");
        assert_eq!(events.last().expect("last event").data["custom"], true);
    }

    #[test]
    fn failure_with_retries_schedules_retry_event() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let enqueued =
            enqueue_sqlite_job(&conn, "thumb", payload("retry"), 10, 3, None).expect("enqueue");
        let claimed = claim_next_sqlite_job(&conn, Some("thumb"), "worker-a")
            .expect("claim")
            .expect("claimed");

        mark_sqlite_job_failed(&conn, &claimed.id, "render failed", 120, Some(123))
            .expect("fail retry");

        let job = get_sqlite_job(&conn, &enqueued.job.id)
            .expect("job")
            .expect("job row");
        assert_eq!(job.state, "queued");
        assert_eq!(job.error.as_deref(), Some("render failed"));
        assert!(job.worker_id.is_none());
        assert!(job.scheduled_at > enqueued.job.scheduled_at);

        let attempt_state: String = conn
            .query_row(
                "SELECT state FROM job_attempts WHERE job_id = ?1 ORDER BY id DESC LIMIT 1",
                [&job.id],
                |row| row.get(0),
            )
            .expect("attempt state");
        assert_eq!(attempt_state, "queued");

        let events = list_sqlite_job_events(&conn, &job.id).expect("events");
        let event = events.last().expect("last event");
        assert_eq!(event.event, "retry_scheduled");
        assert_eq!(event.data["next_state"], "queued");
        assert_eq!(event.data["backoff"], 2);
        assert_eq!(event.data["total_ms"], 123);
    }

    #[test]
    fn final_failure_writes_failed_state_finished_at_attempt_and_event() {
        let (_dir, db_path) = temp_db_path();
        let conn = init_sqlite_db(&db_path).expect("init");
        let enqueued =
            enqueue_sqlite_job(&conn, "thumb", payload("final"), 10, 1, None).expect("enqueue");
        let claimed = claim_next_sqlite_job(&conn, Some("thumb"), "worker-a")
            .expect("claim")
            .expect("claimed");

        mark_sqlite_job_failed(&conn, &claimed.id, "no retries", 120, None).expect("final fail");

        let job = get_sqlite_job(&conn, &enqueued.job.id)
            .expect("job")
            .expect("job row");
        assert_eq!(job.state, "failed");
        assert_eq!(job.error.as_deref(), Some("no retries"));
        assert!(job.finished_at.is_some());

        let attempt_state: String = conn
            .query_row(
                "SELECT state FROM job_attempts WHERE job_id = ?1 ORDER BY id DESC LIMIT 1",
                [&job.id],
                |row| row.get(0),
            )
            .expect("attempt state");
        assert_eq!(attempt_state, "failed");

        let mut names = VecDeque::from(event_names(&conn, &job.id));
        assert_eq!(names.pop_front().as_deref(), Some("enqueued"));
        assert_eq!(names.pop_front().as_deref(), Some("started"));
        assert_eq!(names.pop_front().as_deref(), Some("failed"));

        let events = list_sqlite_job_events(&conn, &job.id).expect("events");
        let event = events.last().expect("last event");
        assert_eq!(event.event, "failed");
        assert_eq!(event.data["next_state"], "failed");
        assert_eq!(event.data["backoff"], 0);
        assert_eq!(event.data["total_ms"], Value::Null);
    }
}

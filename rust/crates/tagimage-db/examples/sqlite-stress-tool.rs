use std::path::Path;
use std::thread::sleep;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde_json::{json, Value};
use tagimage_db::sqlite::{
    enqueue_sqlite_metadata_job, list_sqlite_metadata_source_rows, open_sqlite_runtime_db,
};

fn scalar(conn: &Connection, sql: &str) -> Result<i64, String> {
    conn.query_row(sql, [], |row| row.get(0))
        .map_err(|error| format!("stress audit query failed: {error}; sql={sql}"))
}

fn audit(conn: &Connection) -> Result<Value, String> {
    let job_count = |job_type: &str, state: &str| {
        conn.query_row(
            "SELECT count(*) FROM jobs WHERE job_type = ?1 AND state = ?2",
            [job_type, state],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("count {job_type}/{state} jobs: {error}"))
    };
    let attempt_count = |job_type: &str| {
        conn.query_row(
            r#"
            SELECT count(*)
            FROM job_attempts a
            JOIN jobs j ON j.id = a.job_id
            WHERE j.job_type = ?1
            "#,
            [job_type],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("count {job_type} attempts: {error}"))
    };
    let event_count = |job_type: &str, event: &str| {
        conn.query_row(
            r#"
            SELECT count(*)
            FROM job_events e
            JOIN jobs j ON j.id = e.job_id
            WHERE j.job_type = ?1 AND e.event = ?2
            "#,
            [job_type, event],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("count {job_type}/{event} events: {error}"))
    };

    let states = |job_type: &str| -> Result<Value, String> {
        Ok(json!({
            "queued": job_count(job_type, "queued")?,
            "running": job_count(job_type, "running")?,
            "succeeded": job_count(job_type, "succeeded")?,
            "failed": job_count(job_type, "failed")?,
            "canceled": job_count(job_type, "canceled")?,
            "attempts": attempt_count(job_type)?,
            "enqueued_events": event_count(job_type, "enqueued")?,
            "started_events": event_count(job_type, "started")?,
            "succeeded_events": event_count(job_type, "succeeded")?,
            "failed_events": event_count(job_type, "failed")?,
        }))
    };

    Ok(json!({
        "thumb": states("thumb")?,
        "metadata": states("metadata")?,
        "duplicate_attempts": scalar(conn, r#"
            SELECT count(*) FROM (
                SELECT job_id, attempt
                FROM job_attempts
                GROUP BY job_id, attempt
                HAVING count(*) > 1
            )
        "#)?,
        "duplicate_terminal_events": scalar(conn, r#"
            SELECT count(*) FROM (
                SELECT job_id, event
                FROM job_events
                WHERE event IN ('succeeded', 'failed', 'canceled')
                GROUP BY job_id, event
                HAVING count(*) > 1
            )
        "#)?,
        "stale_running": scalar(conn, r#"
            SELECT count(*)
            FROM jobs
            WHERE state = 'running'
              AND (julianday('now') - julianday(updated_at)) * 86400.0 > 300
        "#)?,
        "recovery_events": scalar(conn,
            "SELECT count(*) FROM job_events WHERE event LIKE '%recover%'"
        )?,
        "metadata_images_with_dimensions": scalar(conn, r#"
            SELECT count(DISTINCT i.id)
            FROM jobs j
            JOIN images i ON i.id = json_extract(j.payload, '$.image_id')
            WHERE j.job_type = 'metadata'
              AND j.state = 'succeeded'
              AND i.width > 0
              AND i.height > 0
        "#)?,
    }))
}

fn seed_metadata(db_path: &Path, limit: i64) -> Result<(), String> {
    let conn = open_sqlite_runtime_db(db_path)?;
    let rows = list_sqlite_metadata_source_rows(&conn, Some(limit))?;
    let mut enqueued = 0usize;
    let mut deduped = 0usize;
    for row in &rows {
        let (_, was_deduped) = enqueue_sqlite_metadata_job(
            &conn,
            &row.id,
            &row.root_path,
            &row.path,
            Some(row.mtime),
            0,
            5,
        )?;
        if was_deduped {
            deduped += 1;
        } else {
            enqueued += 1;
        }
    }
    println!(
        "{}",
        json!({"sources": rows.len(), "enqueued": enqueued, "deduped": deduped})
    );
    Ok(())
}

fn wait_audit(db_path: &Path, timeout_sec: u64) -> Result<(), String> {
    let conn = open_sqlite_runtime_db(db_path)?;
    let deadline = Instant::now() + Duration::from_secs(timeout_sec);
    loop {
        let active = scalar(
            &conn,
            "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')",
        )?;
        if active == 0 {
            println!("{}", audit(&conn)?);
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "timed out after {timeout_sec}s waiting for {active} active jobs"
            ));
        }
        sleep(Duration::from_millis(100));
    }
}

fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let command = args.next().ok_or_else(|| {
        "usage: sqlite-stress-tool <seed-metadata|audit|wait-audit> <db> [value]".to_string()
    })?;
    let db_path = args
        .next()
        .ok_or_else(|| "missing explicit SQLite path".to_string())?;
    match command.as_str() {
        "seed-metadata" => {
            let limit = args
                .next()
                .unwrap_or_else(|| "240".to_string())
                .parse::<i64>()
                .map_err(|error| format!("invalid metadata limit: {error}"))?;
            seed_metadata(Path::new(&db_path), limit)
        }
        "audit" => {
            let conn = open_sqlite_runtime_db(Path::new(&db_path))?;
            println!("{}", audit(&conn)?);
            Ok(())
        }
        "wait-audit" => {
            let timeout_sec = args
                .next()
                .unwrap_or_else(|| "300".to_string())
                .parse::<u64>()
                .map_err(|error| format!("invalid timeout: {error}"))?;
            wait_audit(Path::new(&db_path), timeout_sec)
        }
        _ => Err(format!("unknown command: {command}")),
    }
}

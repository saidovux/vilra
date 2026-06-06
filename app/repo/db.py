import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel

from ..config import (
    JOB_STATE_CANCELED,
    JOB_STATE_FAILED,
    JOB_STATE_QUEUED,
    JOB_STATE_RUNNING,
    JOB_STATE_SUCCEEDED,
    JOB_TYPE_RESCAN,
    JOB_TYPE_THUMB,
    JOB_TTL_HOURS,
    RESCAN_MAX_BACKOFF_SEC,
    SQLITE_PATH,
    THUMB_MAX_BACKOFF_SEC,
    VALID_JOB_STATES,
    job_stale_running_sec,
)

dict_row = sqlite3.Row


def Jsonb(value: Any) -> str:
    return _json_text(value)


db_lock = threading.Lock()
db_initialized = False
db_last_error: Optional[str] = None


def _model_dump(model: BaseModel) -> dict[str, Any]:
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_unset=True)
    return model.dict(exclude_unset=True)


def _now_text() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _json_text(value: Any) -> str:
    return json.dumps(value if value is not None else {}, separators=(",", ":"))


def _json_loads(value: Any, fallback: Any) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except Exception:
        return fallback


def _row_to_dict(row: sqlite3.Row | tuple | None) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    out = dict(row) if isinstance(row, sqlite3.Row) else {}
    if "payload" in out:
        out["payload"] = _json_loads(out["payload"], {})
    if "data" in out:
        out["data"] = _json_loads(out["data"], {})
    for key in ("hidden", "user_defined"):
        if key in out:
            out[key] = bool(out[key])
    return out


@contextmanager
def db_connect(*, row_factory=None, autocommit: bool = True):
    SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(SQLITE_PATH, timeout=5.0, isolation_level=None if autocommit else "DEFERRED")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    if row_factory is not None:
        conn.row_factory = row_factory
    try:
        if not autocommit:
            conn.execute("BEGIN IMMEDIATE")
        yield conn
        if not autocommit:
            conn.commit()
    except Exception:
        if not autocommit:
            conn.rollback()
        raise
    finally:
        conn.close()


def close_db_pools() -> None:
    return None


def ensure_db_ready() -> None:
    global db_initialized, db_last_error
    if db_initialized:
        return

    with db_lock:
        if db_initialized:
            return
        try:
            with db_connect() as conn:
                cur = conn.cursor()
                cur.execute("PRAGMA journal_mode = WAL")
                cur.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS tagimage_schema_version (
                        id INTEGER PRIMARY KEY CHECK (id = 1),
                        version INTEGER NOT NULL,
                        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    );

                    CREATE TABLE IF NOT EXISTS images (
                        id TEXT PRIMARY KEY,
                        root_path TEXT NOT NULL,
                        path TEXT NOT NULL,
                        thumb TEXT NOT NULL,
                        size INTEGER NOT NULL DEFAULT 0 CHECK (size >= 0),
                        mtime INTEGER NOT NULL DEFAULT 0,
                        width INTEGER NOT NULL DEFAULT 0 CHECK (width >= 0),
                        height INTEGER NOT NULL DEFAULT 0 CHECK (height >= 0),
                        ext TEXT NOT NULL DEFAULT 'unknown',
                        hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        UNIQUE (root_path, path)
                    );

                    CREATE TABLE IF NOT EXISTS tags (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        name TEXT NOT NULL,
                        normalized TEXT NOT NULL UNIQUE,
                        color TEXT,
                        user_defined INTEGER NOT NULL DEFAULT 0 CHECK (user_defined IN (0, 1)),
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    );

                    CREATE TABLE IF NOT EXISTS suppressed_auto_tags (
                        normalized TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    );

                    CREATE TABLE IF NOT EXISTS image_tags (
                        image_id TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
                        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                        kind TEXT NOT NULL CHECK (kind IN ('auto', 'user')),
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        PRIMARY KEY (image_id, tag_id, kind)
                    );

                    CREATE TABLE IF NOT EXISTS app_session (
                        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
                        root_path TEXT,
                        root_paths TEXT NOT NULL DEFAULT '[]',
                        search_tags TEXT NOT NULL DEFAULT '[]',
                        search_mode TEXT NOT NULL DEFAULT 'any',
                        last_image_id TEXT,
                        tabs TEXT NOT NULL DEFAULT '[]',
                        active_tab_id TEXT,
                        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    );

                    CREATE TABLE IF NOT EXISTS jobs (
                        id TEXT PRIMARY KEY,
                        job_type TEXT NOT NULL,
                        payload TEXT NOT NULL DEFAULT '{}',
                        dedupe_key TEXT,
                        state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','canceled')),
                        priority INTEGER NOT NULL DEFAULT 0,
                        attempt INTEGER NOT NULL DEFAULT 0,
                        max_attempts INTEGER NOT NULL DEFAULT 3,
                        progress_done INTEGER NOT NULL DEFAULT 0,
                        progress_total INTEGER NOT NULL DEFAULT 0,
                        error TEXT,
                        worker_id TEXT,
                        scheduled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        started_at TEXT,
                        finished_at TEXT,
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    );

                    CREATE TABLE IF NOT EXISTS job_attempts (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                        attempt INTEGER NOT NULL,
                        worker_id TEXT,
                        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                        finished_at TEXT,
                        state TEXT,
                        error TEXT
                    );

                    CREATE TABLE IF NOT EXISTS job_events (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
                        event TEXT NOT NULL,
                        data TEXT NOT NULL DEFAULT '{}',
                        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    );

                    CREATE INDEX IF NOT EXISTS images_root_path_idx ON images(root_path, path);
                    CREATE INDEX IF NOT EXISTS images_root_hidden_idx ON images(root_path, hidden);
                    CREATE INDEX IF NOT EXISTS images_root_hidden_sort_idx ON images(root_path, hidden, lower(path), path, id);
                    CREATE INDEX IF NOT EXISTS images_root_hidden_mtime_idx ON images(root_path, hidden, mtime, lower(path), path, id);
                    CREATE INDEX IF NOT EXISTS images_root_hidden_size_idx ON images(root_path, hidden, size, lower(path), path, id);
                    CREATE INDEX IF NOT EXISTS tags_name_idx ON tags(name);
                    CREATE INDEX IF NOT EXISTS tags_normalized_idx ON tags(normalized);
                    CREATE INDEX IF NOT EXISTS image_tags_image_idx ON image_tags(image_id);
                    CREATE INDEX IF NOT EXISTS image_tags_image_kind_idx ON image_tags(image_id, kind);
                    CREATE INDEX IF NOT EXISTS image_tags_tag_idx ON image_tags(tag_id);
                    CREATE INDEX IF NOT EXISTS image_tags_tag_kind_idx ON image_tags(tag_id, kind);
                    CREATE INDEX IF NOT EXISTS jobs_queue_lookup_idx ON jobs(state, scheduled_at, priority DESC, created_at);
                    CREATE INDEX IF NOT EXISTS jobs_type_state_idx ON jobs(job_type, state, created_at DESC);
                    CREATE INDEX IF NOT EXISTS jobs_type_state_scheduled_idx ON jobs(job_type, state, scheduled_at);
                    CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe_idx
                        ON jobs(job_type, dedupe_key)
                        WHERE dedupe_key IS NOT NULL AND state IN ('queued', 'running');
                    CREATE INDEX IF NOT EXISTS job_attempts_job_id_idx ON job_attempts(job_id, started_at DESC);
                    CREATE INDEX IF NOT EXISTS job_events_job_id_idx ON job_events(job_id, created_at DESC);
                    """
                )
                cur.execute(
                    """
                    INSERT INTO tagimage_schema_version (id, version)
                    VALUES (1, 1)
                    ON CONFLICT(id) DO NOTHING
                    """
                )
                cur.execute("INSERT INTO app_session (id) VALUES (1) ON CONFLICT(id) DO NOTHING")
            db_initialized = True
            db_last_error = None
        except Exception as exc:
            db_last_error = str(exc)
            raise


def db_health() -> dict[str, Any]:
    try:
        ensure_db_ready()
        with db_connect() as conn:
            conn.execute("SELECT 1").fetchone()
        return {"db_ready": True, "db_error": None}
    except Exception as exc:
        return {"db_ready": False, "db_error": str(exc)}


def verify_core_tables() -> list[str]:
    ensure_db_ready()
    required = {
        "tagimage_schema_version",
        "images",
        "tags",
        "suppressed_auto_tags",
        "image_tags",
        "app_session",
    }
    with db_connect() as conn:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    names = {row[0] for row in rows}
    missing = sorted(required - names)
    if missing:
        raise RuntimeError(f"missing SQLite core tables: {', '.join(missing)}")
    return sorted(required)


def verify_job_tables() -> list[str]:
    ensure_db_ready()
    required = {"jobs", "job_attempts", "job_events"}
    with db_connect() as conn:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    names = {row[0] for row in rows}
    missing = sorted(required - names)
    if missing:
        raise RuntimeError(f"missing SQLite job tables: {', '.join(missing)}")
    return sorted(required)


def normalize_tag(tag: str) -> str:
    return " ".join(tag.strip().split()).lower()


def clean_tag_list(tags: list[str]) -> list[str]:
    cleaned: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        name = " ".join(str(tag).strip().split())
        norm = normalize_tag(name)
        if not name or norm in seen:
            continue
        cleaned.append(name)
        seen.add(norm)
    return cleaned


def parse_csv_tags(raw: Optional[str]) -> list[str]:
    if not raw:
        return []
    return [normalize_tag(t) for t in raw.split(",") if t.strip()]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _job_from_row(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
    return _row_to_dict(row)


def enqueue_job(
    job_type: str,
    payload: Optional[dict[str, Any]] = None,
    *,
    priority: int = 0,
    max_attempts: int = 3,
    dedupe_key: Optional[str] = None,
) -> dict[str, Any]:
    ensure_db_ready()
    payload = payload or {}
    with db_connect(row_factory=dict_row, autocommit=False) as conn:
        cur = conn.cursor()
        if dedupe_key:
            existing = cur.execute(
                """
                SELECT *
                FROM jobs
                WHERE job_type = ?
                  AND dedupe_key = ?
                  AND state IN ('queued', 'running')
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (job_type, dedupe_key),
            ).fetchone()
            if existing is not None:
                out = _job_from_row(existing) or {}
                out["__deduped"] = True
                return out

        job_id = uuid.uuid4().hex
        cur.execute(
            """
            INSERT INTO jobs (id, job_type, payload, state, priority, max_attempts, scheduled_at, dedupe_key)
            VALUES (?, ?, ?, 'queued', ?, max(1, ?), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
            """,
            (job_id, job_type, _json_text(payload), int(priority), int(max_attempts), dedupe_key),
        )
        cur.execute(
            "INSERT INTO job_events (job_id, event, data) VALUES (?, 'enqueued', ?)",
            (job_id, _json_text({"job_type": job_type})),
        )
        job = _job_from_row(cur.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()) or {}
        job["__deduped"] = False
        return job


def get_job(job_id: str) -> Optional[dict[str, Any]]:
    ensure_db_ready()
    with db_connect(row_factory=dict_row) as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _job_from_row(row)


def list_jobs(*, job_type: Optional[str] = None, state: Optional[str] = None, limit: int = 50) -> list[dict[str, Any]]:
    ensure_db_ready()
    where = []
    params: list[Any] = []
    if job_type:
        where.append("job_type = ?")
        params.append(job_type)
    if state:
        if state not in VALID_JOB_STATES:
            return []
        where.append("state = ?")
        params.append(state)
    sql = "SELECT * FROM jobs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(max(1, min(int(limit), 200)))
    with db_connect(row_factory=dict_row) as conn:
        return [_job_from_row(row) or {} for row in conn.execute(sql, params).fetchall()]


def count_jobs(*, job_type: Optional[str] = None, state: Optional[str] = None) -> int:
    ensure_db_ready()
    where = []
    params: list[Any] = []
    if job_type:
        where.append("job_type = ?")
        params.append(job_type)
    if state:
        if state not in VALID_JOB_STATES:
            return 0
        where.append("state = ?")
        params.append(state)
    sql = "SELECT COUNT(*) FROM jobs"
    if where:
        sql += " WHERE " + " AND ".join(where)
    with db_connect() as conn:
        return int(conn.execute(sql, params).fetchone()[0])


def _stale_activity_expr() -> str:
    return "max(COALESCE(started_at, created_at, '0000-01-01T00:00:00.000Z'), COALESCE(updated_at, started_at, created_at, '0000-01-01T00:00:00.000Z'))"


def count_stale_running_jobs(
    *, job_type: Optional[str] = None, stale_after_sec: Optional[int] = None
) -> int:
    stale_sec = job_stale_running_sec() if stale_after_sec is None else int(stale_after_sec)
    if stale_sec <= 0:
        return 0
    ensure_db_ready()
    params: list[Any] = [stale_sec]
    where = [
        "state = 'running'",
        f"{_stale_activity_expr()} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d seconds', ?))",
    ]
    if job_type:
        where.append("job_type = ?")
        params.append(job_type)
    with db_connect() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM jobs WHERE " + " AND ".join(where), params).fetchone()[0])


def find_active_job_by_dedupe(job_type: str, dedupe_key: str) -> Optional[dict[str, Any]]:
    ensure_db_ready()
    with db_connect(row_factory=dict_row) as conn:
        row = conn.execute(
            """
            SELECT *
            FROM jobs
            WHERE job_type = ?
              AND dedupe_key = ?
              AND state IN ('queued', 'running')
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (job_type, dedupe_key),
        ).fetchone()
        return _job_from_row(row)


def claim_next_job(worker_id: str, *, job_type: Optional[str] = None) -> Optional[dict[str, Any]]:
    ensure_db_ready()
    with db_connect(row_factory=dict_row, autocommit=False) as conn:
        cur = conn.cursor()
        if job_type:
            row = cur.execute(
                """
                UPDATE jobs
                SET state = 'running',
                    worker_id = ?,
                    started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    attempt = attempt + 1,
                    error = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = (
                    SELECT id FROM jobs
                    WHERE state = 'queued'
                      AND scheduled_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                      AND job_type = ?
                    ORDER BY priority DESC, scheduled_at, created_at
                    LIMIT 1
                )
                RETURNING *
                """,
                (worker_id, job_type),
            ).fetchone()
        else:
            row = cur.execute(
                """
                UPDATE jobs
                SET state = 'running',
                    worker_id = ?,
                    started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                    attempt = attempt + 1,
                    error = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = (
                    SELECT id FROM jobs
                    WHERE state = 'queued'
                      AND scheduled_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    ORDER BY priority DESC, scheduled_at, created_at
                    LIMIT 1
                )
                RETURNING *
                """,
                (worker_id,),
            ).fetchone()
        if row is None:
            return None
        job = _job_from_row(row) or {}
        cur.execute(
            "INSERT INTO job_attempts (job_id, attempt, worker_id, state) VALUES (?, ?, ?, 'running')",
            (job["id"], int(job["attempt"] or 0), worker_id),
        )
        cur.execute(
            "INSERT INTO job_events (job_id, event, data) VALUES (?, 'started', ?)",
            (job["id"], _json_text({"attempt": int(job["attempt"] or 0), "worker_id": worker_id})),
        )
        return job


def touch_job_progress(job_id: str, *, done: int, total: Optional[int] = None) -> None:
    ensure_db_ready()
    with db_connect() as conn:
        if total is None:
            conn.execute(
                """
                UPDATE jobs
                SET progress_done = max(0, ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (int(done), job_id),
            )
        else:
            conn.execute(
                """
                UPDATE jobs
                SET progress_done = max(0, ?),
                    progress_total = max(0, ?),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (int(done), int(total), job_id),
            )


def _set_last_attempt_state(cur, job_id: str, state: str, error: Optional[str] = None) -> None:
    cur.execute(
        """
        UPDATE job_attempts
        SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), state = ?, error = ?
        WHERE id = (
            SELECT id FROM job_attempts
            WHERE job_id = ?
            ORDER BY started_at DESC, id DESC
            LIMIT 1
        )
        """,
        (state, error, job_id),
    )


def mark_job_succeeded(job_id: str, *, total: Optional[int] = None) -> None:
    ensure_db_ready()
    with db_connect(row_factory=dict_row, autocommit=False) as conn:
        cur = conn.cursor()
        current = cur.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        resolved_total = int(total if total is not None else ((current["progress_total"] if current else 0) or (current["progress_done"] if current else 0) or 0))
        if total is None:
            cur.execute(
                """
                UPDATE jobs
                SET state = 'succeeded',
                    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    error = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (job_id,),
            )
        else:
            cur.execute(
                """
                UPDATE jobs
                SET state = 'succeeded',
                    progress_done = max(0, ?),
                    progress_total = max(0, ?),
                    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    error = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (resolved_total, resolved_total, job_id),
            )
        _set_last_attempt_state(cur, job_id, JOB_STATE_SUCCEEDED, None)
        cur.execute(
            "INSERT INTO job_events (job_id, event, data) VALUES (?, 'succeeded', ?)",
            (job_id, _json_text({"total": resolved_total})),
        )


def mark_job_failed(job_id: str, error: str) -> None:
    ensure_db_ready()
    with db_connect(row_factory=dict_row, autocommit=False) as conn:
        cur = conn.cursor()
        row = cur.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            return
        attempt = int(row["attempt"] or 0)
        max_attempts = int(row["max_attempts"] or 1)
        job_type = row["job_type"] or ""
        retries_left = max(0, max_attempts - attempt)
        if retries_left > 0:
            max_backoff = THUMB_MAX_BACKOFF_SEC if job_type == JOB_TYPE_THUMB else RESCAN_MAX_BACKOFF_SEC if job_type == JOB_TYPE_RESCAN else 120
            backoff = min(int(max_backoff), 2 ** max(1, attempt))
            next_state = JOB_STATE_QUEUED
            event = "retry_scheduled"
            cur.execute(
                """
                UPDATE jobs
                SET state = 'queued',
                    error = ?,
                    scheduled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('+%d seconds', ?)),
                    worker_id = NULL,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (error, backoff, job_id),
            )
        else:
            backoff = 0
            next_state = JOB_STATE_FAILED
            event = "failed"
            cur.execute(
                """
                UPDATE jobs
                SET state = 'failed',
                    error = ?,
                    finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                """,
                (error, job_id),
            )
        _set_last_attempt_state(cur, job_id, next_state, error)
        cur.execute(
            "INSERT INTO job_events (job_id, event, data) VALUES (?, ?, ?)",
            (
                job_id,
                event,
                _json_text(
                    {
                        "error": error,
                        "attempt": attempt,
                        "max_attempts": max_attempts,
                        "next_state": next_state,
                        "backoff": backoff,
                    }
                ),
            ),
        )


def recover_stale_running_jobs(
    *, stale_after_sec: Optional[int] = None, limit: int = 100
) -> dict[str, Any]:
    stale_sec = job_stale_running_sec() if stale_after_sec is None else int(stale_after_sec)
    if stale_sec <= 0:
        return {"disabled": True, "checked": 0, "recovered": 0, "requeued": 0, "failed": 0}
    ensure_db_ready()
    capped_limit = max(1, min(int(limit), 500))
    checked = requeued = failed = 0
    activity = _stale_activity_expr()
    with db_connect(row_factory=dict_row, autocommit=False) as conn:
        cur = conn.cursor()
        stale_jobs = cur.execute(
            f"""
            SELECT *,
                   CAST(strftime('%s', 'now') - strftime('%s', {activity}) AS INTEGER) AS age_sec
            FROM jobs
            WHERE state = 'running'
              AND {activity} <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d seconds', ?))
            ORDER BY updated_at, started_at, created_at
            LIMIT ?
            """,
            (stale_sec, capped_limit),
        ).fetchall()
        checked = len(stale_jobs)
        for job in stale_jobs:
            job_id = job["id"]
            attempt = int(job["attempt"] or 0)
            max_attempts = int(job["max_attempts"] or 1)
            previous_worker = job["worker_id"]
            age_sec = int(job["age_sec"] or 0)
            if attempt < max_attempts:
                next_state = JOB_STATE_QUEUED
                error = "stale running job recovered"
                event_name = "recovered"
                changed = cur.execute(
                    """
                    UPDATE jobs
                    SET state = 'queued',
                        scheduled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                        worker_id = NULL,
                        error = ?,
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ? AND state = 'running'
                    """,
                    (error, job_id),
                ).rowcount
                requeued += max(0, changed)
            else:
                next_state = JOB_STATE_FAILED
                error = "stale running job exceeded max attempts"
                event_name = "recovered_failed"
                changed = cur.execute(
                    """
                    UPDATE jobs
                    SET state = 'failed',
                        error = ?,
                        finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ? AND state = 'running'
                    """,
                    (error, job_id),
                ).rowcount
                failed += max(0, changed)
            if changed <= 0:
                continue
            _set_last_attempt_state(cur, job_id, next_state, error)
            cur.execute(
                "INSERT INTO job_events (job_id, event, data) VALUES (?, ?, ?)",
                (
                    job_id,
                    event_name,
                    _json_text(
                        {
                            "attempt": attempt,
                            "max_attempts": max_attempts,
                            "previous_worker": previous_worker,
                            "age_sec": age_sec,
                            "stale_after_sec": stale_sec,
                            "next_state": next_state,
                        }
                    ),
                ),
            )
    recovered = requeued + failed
    return {"disabled": False, "checked": checked, "recovered": recovered, "requeued": requeued, "failed": failed}


def cleanup_old_jobs(*, ttl_hours: Optional[int] = None) -> dict[str, int]:
    ensure_db_ready()
    keep_hours = int(ttl_hours or JOB_TTL_HOURS)
    with db_connect() as conn:
        cur = conn.execute(
            """
            DELETE FROM jobs
            WHERE state IN ('succeeded', 'failed', 'canceled')
              AND finished_at IS NOT NULL
              AND finished_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d hours', ?))
            """,
            (keep_hours,),
        )
        return {"removed_jobs": int(cur.rowcount or 0)}


def cancel_job(job_id: str) -> bool:
    ensure_db_ready()
    with db_connect() as conn:
        cur = conn.execute(
            """
            UPDATE jobs
            SET state = 'canceled',
                finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ? AND state IN ('queued','running')
            """,
            (job_id,),
        )
        return cur.rowcount > 0


def serialize_job(job: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    if job is None:
        return None
    payload = _json_loads(job.get("payload"), {}) if isinstance(job.get("payload"), str) else (job.get("payload") or {})
    return {
        "id": job.get("id"),
        "type": job.get("job_type"),
        "state": job.get("state"),
        "priority": int(job.get("priority") or 0),
        "attempt": int(job.get("attempt") or 0),
        "max_attempts": int(job.get("max_attempts") or 0),
        "progress": {
            "done": int(job.get("progress_done") or 0),
            "total": int(job.get("progress_total") or 0),
        },
        "error": job.get("error"),
        "worker_id": job.get("worker_id"),
        "payload": payload,
        "scheduled_at": job.get("scheduled_at"),
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
    }

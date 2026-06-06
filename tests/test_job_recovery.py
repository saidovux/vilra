import os
import uuid
from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def db_available():
    os.environ.setdefault("IMGVIEWER_INLINE_WORKER", "0")
    from app.repo.db import ensure_db_ready

    try:
        ensure_db_ready()
    except Exception as exc:
        pytest.skip(f"SQLite runtime DB is required for job recovery tests: {exc}")
    return True


def _enqueue_thumb_job(root: Path, *, max_attempts: int = 3) -> dict:
    from app.repo.db import enqueue_job

    return enqueue_job(
        "thumb",
        {
            "root_path": str(root),
            "path": "image.jpg",
            "thumb": ".imgindex/thumbs/image.jpg",
            "image_id": uuid.uuid4().hex[:12],
            "mtime": 1,
            "max_size": [640, 640],
        },
        max_attempts=max_attempts,
    )


def _mark_running(
    job_id: str,
    *,
    age_sec: int,
    attempt: int = 1,
    max_attempts: int = 3,
    worker_id: str = "pytest-stale-worker",
) -> None:
    from app.repo.db import db_connect

    with db_connect() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            UPDATE jobs
            SET state = 'running',
                attempt = ?,
                max_attempts = ?,
                worker_id = ?,
                started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d seconds', ?)),
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d seconds', ?)),
                error = NULL
            WHERE id = ?
            """,
            (attempt, max_attempts, worker_id, age_sec, age_sec, job_id),
        )
        cur.execute(
            """
            INSERT INTO job_attempts (job_id, attempt, worker_id, state)
            VALUES (?, ?, ?, 'running')
            """,
            (job_id, attempt, worker_id),
        )


def _latest_event(job_id: str) -> tuple[str, dict]:
    from app.repo.db import db_connect

    with db_connect() as conn:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT event, data
            FROM job_events
            WHERE job_id = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (job_id,),
        )
        row = cur.fetchone()
    assert row is not None
    import json

    data = row[1]
    if isinstance(data, str):
        data = json.loads(data)
    return row[0], data


def test_recover_stale_running_job_requeues_and_records_event(db_available, tmp_path):
    from app.repo.db import get_job, recover_stale_running_jobs

    job = _enqueue_thumb_job(tmp_path)
    _mark_running(job["id"], age_sec=600, worker_id="old-thumb-worker")

    result = recover_stale_running_jobs(stale_after_sec=300)

    recovered = get_job(job["id"])
    assert result["requeued"] == 1
    assert recovered["state"] == "queued"
    assert recovered["worker_id"] is None
    assert recovered["error"] == "stale running job recovered"

    event, data = _latest_event(job["id"])
    assert event == "recovered"
    assert data["previous_worker"] == "old-thumb-worker"
    assert data["next_state"] == "queued"


def test_recover_stale_running_job_does_not_touch_fresh_running_job(db_available, tmp_path):
    from app.repo.db import get_job, recover_stale_running_jobs

    job = _enqueue_thumb_job(tmp_path)
    _mark_running(job["id"], age_sec=30, worker_id="fresh-worker")

    result = recover_stale_running_jobs(stale_after_sec=300)

    fresh = get_job(job["id"])
    assert result["recovered"] == 0
    assert fresh["state"] == "running"
    assert fresh["worker_id"] == "fresh-worker"


def test_recover_stale_running_job_can_be_disabled_with_env(db_available, tmp_path, monkeypatch):
    from app.repo.db import get_job, recover_stale_running_jobs

    job = _enqueue_thumb_job(tmp_path)
    _mark_running(job["id"], age_sec=600, worker_id="disabled-worker")
    monkeypatch.setenv("IMGVIEWER_JOB_STALE_RUNNING_SEC", "0")

    result = recover_stale_running_jobs()

    disabled = get_job(job["id"])
    assert result["disabled"] is True
    assert result["recovered"] == 0
    assert disabled["state"] == "running"
    assert disabled["worker_id"] == "disabled-worker"


def test_recover_stale_running_job_fails_after_max_attempts(db_available, tmp_path):
    from app.repo.db import get_job, recover_stale_running_jobs

    job = _enqueue_thumb_job(tmp_path, max_attempts=2)
    _mark_running(job["id"], age_sec=600, attempt=2, max_attempts=2, worker_id="exhausted-worker")

    result = recover_stale_running_jobs(stale_after_sec=300)

    failed = get_job(job["id"])
    assert result["failed"] == 1
    assert failed["state"] == "failed"
    assert failed["error"] == "stale running job exceeded max attempts"

    event, data = _latest_event(job["id"])
    assert event == "recovered_failed"
    assert data["previous_worker"] == "exhausted-worker"
    assert data["next_state"] == "failed"

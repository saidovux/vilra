from typing import Any, Optional

from ..contracts.metadata import build_metadata_payload, metadata_dedupe_key
from ..repo.db import db_connect, dict_row, enqueue_job, ensure_db_ready

JOB_TYPE_METADATA = "metadata"


def enqueue_metadata_job_for_image(
    *,
    image_id: str,
    root_path: str,
    path: str,
    mtime: Optional[int] = None,
    priority: int = 0,
    max_attempts: int = 3,
) -> dict[str, Any]:
    payload = build_metadata_payload(image_id=image_id, root_path=root_path, path=path)
    dedupe_key = metadata_dedupe_key(image_id=image_id, mtime=mtime, path=path)
    return enqueue_job(
        JOB_TYPE_METADATA,
        payload,
        priority=priority,
        max_attempts=max_attempts,
        dedupe_key=dedupe_key,
    )


def _list_metadata_source_rows(*, limit: int | None) -> list[dict[str, Any]]:
    ensure_db_ready()
    max_rows = 0 if limit is None else max(0, min(int(limit), 200000))

    with db_connect(row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            sql = """
                SELECT id, root_path, path, mtime
                FROM images
                WHERE hidden = false
                ORDER BY root_path, lower(path), path
            """
            params: list[Any] = []
            if max_rows > 0:
                sql += " LIMIT ?"
                params.append(max_rows)
            cur.execute(sql, params)
            return list(cur.fetchall())


def enqueue_metadata_jobs_for_existing_images(limit: int | None = None) -> dict[str, int]:
    rows = _list_metadata_source_rows(limit=limit)
    enqueued = 0
    queued_existing = 0

    for row in rows:
        mtime_value = row.get("mtime")
        mtime = int(mtime_value) if mtime_value is not None else None
        job = enqueue_metadata_job_for_image(
            image_id=row["id"],
            root_path=row["root_path"],
            path=row["path"],
            mtime=mtime,
        )
        if bool(job.get("__deduped")):
            queued_existing += 1
        else:
            enqueued += 1

    return {
        "enqueued": enqueued,
        "queued_existing": queued_existing,
        "total": len(rows),
    }

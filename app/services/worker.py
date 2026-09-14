import argparse
import socket
import time
from pathlib import Path

from ..config import JOB_TYPE_RESCAN
from ..repo.db import claim_next_job, ensure_db_ready, mark_job_failed, recover_stale_running_jobs
from ..services.scanner import run_rescan_job


def process_job(job: dict) -> None:
    job_type = job.get("job_type")
    payload = job.get("payload") or {}
    if job_type == JOB_TYPE_RESCAN:
        root_path = payload.get("root_path")
        if not root_path:
            raise RuntimeError("Missing root_path in rescan payload")
        run_rescan_job(root=Path(root_path), job_id=job["id"])
        return
    raise RuntimeError(f"Unsupported job_type: {job_type}")


def worker_loop(*, poll_interval: float = 1.0, once: bool = False, worker_id: str) -> int:
    ensure_db_ready()
    recover_stale_running_jobs()
    processed = 0
    while True:
        job = claim_next_job(worker_id, job_type=JOB_TYPE_RESCAN)
        if job is None:
            if once:
                return processed
            time.sleep(poll_interval)
            continue
        try:
            process_job(job)
        except Exception as exc:
            mark_job_failed(job["id"], str(exc))
        finally:
            processed += 1
        if once:
            return processed


def main() -> None:
    parser = argparse.ArgumentParser(description="Vilra background worker")
    parser.add_argument("--poll", type=float, default=1.0, help="queue poll interval in seconds")
    parser.add_argument("--once", action="store_true", help="process one job and exit")
    parser.add_argument("--worker-id", default=None, help="optional custom worker id")
    args = parser.parse_args()

    worker_id = args.worker_id or f"worker-{socket.gethostname()}-{int(time.time())}"
    print(f"[tagimage-worker] started as {worker_id}")
    processed = worker_loop(poll_interval=max(0.1, args.poll), once=args.once, worker_id=worker_id)
    print(f"[tagimage-worker] stopped, processed={processed}")


if __name__ == "__main__":
    main()

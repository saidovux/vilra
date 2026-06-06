import os

from tagimage_env import ensure_sqlite_path

SQLITE_PATH = ensure_sqlite_path()

SUPPORTED_EXT = {".jpg", ".jpeg", ".png", ".webp"}
INDEX_DIR_NAME = ".imgindex"
THUMBS_DIR_NAME = "thumbs"
THUMB_MAX_SIZE = (640, 640)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


LEGACY_PYTHON = _env_bool("IMGVIEWER_LEGACY_PYTHON", False)
THUMB_JOB_MODE = os.getenv(
    "IMGVIEWER_THUMB_JOB_MODE",
    "sync" if LEGACY_PYTHON else "queue",
).strip().lower()


def _env_int(name: str, default: int, *, min_value: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw.strip())
    except Exception:
        return default
    return max(min_value, value)

DEFAULT_PAGE_LIMIT = 120
MAX_PAGE_LIMIT = 500
THUMB_WAIT_MS = _env_int("IMGVIEWER_THUMB_WAIT_MS", 1200, min_value=0)
THUMB_POLL_MS = _env_int("IMGVIEWER_THUMB_POLL_MS", 120, min_value=10)
THUMB_SYNC_FALLBACK = _env_bool("IMGVIEWER_THUMB_SYNC_FALLBACK", False)

JOB_TTL_HOURS = _env_int("IMGVIEWER_JOB_TTL_HOURS", 168, min_value=1)
JOB_CLEANUP_INTERVAL_SEC = _env_int("IMGVIEWER_JOB_CLEANUP_INTERVAL_SEC", 3600, min_value=30)
JOB_STALE_RUNNING_SEC = _env_int("IMGVIEWER_JOB_STALE_RUNNING_SEC", 300, min_value=0)

THUMB_MAX_ATTEMPTS = _env_int("IMGVIEWER_THUMB_MAX_ATTEMPTS", 5, min_value=1)
RESCAN_MAX_ATTEMPTS = _env_int("IMGVIEWER_RESCAN_MAX_ATTEMPTS", 3, min_value=1)
THUMB_MAX_BACKOFF_SEC = _env_int("IMGVIEWER_THUMB_MAX_BACKOFF_SEC", 300, min_value=1)
RESCAN_MAX_BACKOFF_SEC = _env_int("IMGVIEWER_RESCAN_MAX_BACKOFF_SEC", 120, min_value=1)

RESCAN_WORKER_EXPECTED = _env_bool("IMGVIEWER_RESCAN_WORKER_EXPECTED", True)
THUMB_WORKER_EXPECTED = _env_bool("IMGVIEWER_THUMB_WORKER_EXPECTED", THUMB_JOB_MODE == "queue")

JOB_STATE_QUEUED = "queued"
JOB_STATE_RUNNING = "running"
JOB_STATE_SUCCEEDED = "succeeded"
JOB_STATE_FAILED = "failed"
JOB_STATE_CANCELED = "canceled"

JOB_TYPE_RESCAN = "rescan"
JOB_TYPE_THUMB = "thumb"
JOB_TYPE_INDEX = "index"
JOB_TYPE_SCANNER_SHADOW = "scanner_shadow"

VALID_MATCH_MODES = {"any", "all"}
VALID_JOB_STATES = {
    JOB_STATE_QUEUED,
    JOB_STATE_RUNNING,
    JOB_STATE_SUCCEEDED,
    JOB_STATE_FAILED,
    JOB_STATE_CANCELED,
}


def job_stale_running_sec() -> int:
    return _env_int("IMGVIEWER_JOB_STALE_RUNNING_SEC", JOB_STALE_RUNNING_SEC, min_value=0)

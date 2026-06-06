import atexit
import os
import shutil
import tempfile
from collections.abc import Generator

import pytest

from tagimage_env import load_env_file


_TEST_DB_DIR = tempfile.mkdtemp(prefix="tagimage-pytest-")
_TEST_DB_PATH = os.path.join(_TEST_DB_DIR, "tagimage.sqlite")


def _cleanup_test_db_dir() -> None:
    shutil.rmtree(_TEST_DB_DIR, ignore_errors=True)


atexit.register(_cleanup_test_db_dir)


def configure_effective_sqlite_path() -> None:
    load_env_file()
    os.environ["TAGIMAGE_SQLITE_PATH"] = _TEST_DB_PATH
    os.environ["TAGIMAGE_TEST_DB_ISOLATION"] = "sqlite_temp"


configure_effective_sqlite_path()


def configure_test_runtime_env() -> None:
    os.environ.setdefault("IMGVIEWER_INLINE_WORKER", "0")
    os.environ.setdefault("IMGVIEWER_THUMB_JOB_MODE", "queue")
    os.environ.setdefault("IMGVIEWER_THUMB_WAIT_MS", "50")
    os.environ.setdefault("IMGVIEWER_THUMB_POLL_MS", "20")
    os.environ.setdefault("IMGVIEWER_THUMB_SYNC_FALLBACK", "0")
    os.environ.setdefault("IMGVIEWER_THUMB_WORKER_EXPECTED", "1")


configure_test_runtime_env()


def reset_app_session(cur) -> None:
    cur.execute("INSERT INTO app_session (id) VALUES (1) ON CONFLICT(id) DO NOTHING")
    cur.execute(
        """
        UPDATE app_session
        SET root_path = NULL,
            root_paths = '[]',
            search_tags = '[]',
            search_mode = 'any',
            last_image_id = NULL,
            tabs = '[]',
            active_tab_id = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = 1
        """
    )


def truncate_test_tables(cur) -> None:
    for table in (
        "job_events",
        "job_attempts",
        "jobs",
        "image_tags",
        "images",
        "suppressed_auto_tags",
        "tags",
    ):
        cur.execute(f"DELETE FROM {table}")
    cur.execute("DELETE FROM sqlite_sequence WHERE name IN ('job_events', 'job_attempts', 'tags')")
    reset_app_session(cur)


def reset_runtime_state() -> None:
    try:
        from app import state

        state.ROOT_FOLDER = None
        state.ROOT_FOLDERS = []
    except Exception:
        pass


@pytest.fixture(scope="session", autouse=True)
def configure_test_database() -> None:
    configure_effective_sqlite_path()
    from app.repo.db import ensure_db_ready

    ensure_db_ready()


@pytest.fixture(autouse=True)
def isolate_integration_db_state(request) -> Generator[None, None, None]:
    module_name = getattr(request.module, "__name__", "")
    if not (
        module_name.endswith("test_api_integration")
        or module_name.endswith("test_job_recovery")
        or module_name.endswith("test_metadata_jobs")
    ):
        yield
        return

    from app.repo.db import db_connect, ensure_db_ready

    ensure_db_ready()
    reset_runtime_state()
    with db_connect() as conn:
        truncate_test_tables(conn.cursor())

    try:
        yield
    finally:
        reset_runtime_state()
        with db_connect() as conn:
            truncate_test_tables(conn.cursor())

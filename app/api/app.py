import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ..config import JOB_CLEANUP_INTERVAL_SEC, job_stale_running_sec
from ..repo.db import cleanup_old_jobs, close_db_pools, ensure_db_ready, recover_stale_running_jobs
from ..services.app_state import restore_root_from_session
from ..services.inline_worker import start_inline_worker_if_enabled
from .routes import files, folders, images, jobs, session, static, status, tags, thumbs

executor = ThreadPoolExecutor(max_workers=4)
cleanup_task: Optional[asyncio.Task] = None


def _pick_folder_native() -> dict[str, Any]:
    return folders.pick_folder_native_default()


def _job_maintenance_sleep_sec() -> int:
    stale_sec = job_stale_running_sec()
    if stale_sec <= 0:
        return JOB_CLEANUP_INTERVAL_SEC
    return min(JOB_CLEANUP_INTERVAL_SEC, max(30, stale_sec))


async def _job_cleanup_loop() -> None:
    while True:
        try:
            recover_stale_running_jobs()
            cleanup_old_jobs()
        except Exception:
            pass
        await asyncio.sleep(_job_maintenance_sleep_sec())


def create_app() -> FastAPI:
    app = FastAPI(title="Vilra")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    folders.configure_runtime(executor=executor, pick_folder_callback=lambda: _pick_folder_native())
    thumbs.configure_runtime(executor=executor)

    @app.on_event("startup")
    async def startup_restore_session() -> None:
        global cleanup_task
        try:
            ensure_db_ready()
            restore_root_from_session()
            recover_stale_running_jobs()
            start_inline_worker_if_enabled()
            if cleanup_task is None or cleanup_task.done():
                cleanup_task = asyncio.create_task(_job_cleanup_loop())
        except Exception:
            pass

    @app.on_event("shutdown")
    async def shutdown_tasks() -> None:
        global cleanup_task
        if cleanup_task is not None:
            cleanup_task.cancel()
            cleanup_task = None
        close_db_pools()

    app.include_router(folders.router)
    app.include_router(status.router)
    app.include_router(session.router)
    app.include_router(images.router)
    app.include_router(tags.router)
    app.include_router(thumbs.router)
    app.include_router(files.router)
    app.include_router(jobs.router)
    app.include_router(static.router)
    static.mount_static(app)
    return app


app = create_app()

import os
import uuid
from pathlib import Path
from typing import Any, Optional

from ..config import (
    INDEX_DIR_NAME,
    THUMB_MAX_ATTEMPTS,
    SUPPORTED_EXT,
    THUMB_JOB_MODE,
    THUMB_MAX_SIZE,
    THUMBS_DIR_NAME,
)
from ..repo.content import (
    cleanup_hidden_image_tag_data,
    fetch_existing_images_map,
    mark_images_hidden_for_root,
    replace_image_tags,
    upsert_image_row,
)
from ..repo.db import (
    db_connect,
    ensure_db_ready,
    mark_job_failed,
    mark_job_succeeded,
    touch_job_progress,
)
from ..state import ROOT_FOLDER
from .thumbnail_jobs_service import enqueue_thumb_job

try:
    from PIL import Image

    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False


def image_dimensions(img_path: Path) -> tuple[int, int]:
    if not PIL_AVAILABLE:
        return 0, 0
    try:
        with Image.open(img_path) as im:
            return im.size
    except Exception:
        return 0, 0


def make_thumb_sync(img_path: Path, thumb_path: Path, *, max_size: tuple[int, int] = THUMB_MAX_SIZE) -> bool:
    if not PIL_AVAILABLE:
        return False
    try:
        with Image.open(img_path) as im:
            im.thumbnail(max_size, Image.LANCZOS)
            if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                rgba = im.convert("RGBA")
                background = Image.new("RGB", rgba.size, (18, 18, 18))
                background.paste(rgba, mask=rgba.getchannel("A"))
                im = background
            else:
                im = im.convert("RGB")

            thumb_path.parent.mkdir(parents=True, exist_ok=True)
            im.save(thumb_path, "JPEG", quality=86, optimize=True)
        return True
    except Exception as exc:
        print(f"thumb error {img_path}: {exc}")
        return False


def scan_image_paths(root: Path) -> list[Path]:
    images_found: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != INDEX_DIR_NAME]
        dp = Path(dirpath)
        for filename in filenames:
            if Path(filename).suffix.lower() in SUPPORTED_EXT:
                images_found.append(dp / filename)
    images_found.sort(key=lambda path: str(path.relative_to(root)).lower())
    return images_found


def _scan_paths(root: Path) -> list[Path]:
    return scan_image_paths(root)


def build_image_record_from_path(root: Path, img_path: Path) -> dict[str, Any]:
    rel = str(img_path.relative_to(root))
    stat = img_path.stat()
    width, height = image_dimensions(img_path)
    return {
        "rel": rel,
        "stat": stat,
        "size": int(stat.st_size),
        "mtime": int(stat.st_mtime),
        "width": width,
        "height": height,
    }


def should_regenerate_thumb(src_stat: os.stat_result, thumb_path: Path) -> bool:
    return not thumb_path.exists() or int(thumb_path.stat().st_mtime) < int(src_stat.st_mtime)


def process_scanned_image(
    *,
    cur,
    root: Path,
    root_str: str,
    img_path: Path,
    existing_by_rel: dict[str, str],
) -> None:
    image_record = build_image_record_from_path(root, img_path)
    rel = image_record["rel"]
    stat = image_record["stat"]
    existing_id = existing_by_rel.get(rel) or uuid.uuid4().hex[:12]
    thumb_rel = f"{INDEX_DIR_NAME}/{THUMBS_DIR_NAME}/{existing_id}.jpg"
    thumb_path = root / thumb_rel

    db_img_id = upsert_image_row(
        cur,
        root_str=root_str,
        rel=rel,
        thumb_rel=thumb_rel,
        size=image_record["size"],
        mtime=image_record["mtime"],
        width=image_record["width"],
        height=image_record["height"],
        existing_id=existing_id,
    )

    replace_image_tags(cur, db_img_id, [], "auto")

    if should_regenerate_thumb(stat, thumb_path):
        if THUMB_JOB_MODE == "queue":
            enqueue_thumb_job(
                image_id=db_img_id,
                root_path=root_str,
                path=rel,
                thumb=thumb_rel,
                mtime=image_record["mtime"],
                max_size=THUMB_MAX_SIZE,
                priority=20,
                max_attempts=THUMB_MAX_ATTEMPTS,
            )
        else:
            make_thumb_sync(img_path, thumb_path, max_size=THUMB_MAX_SIZE)


def finalize_scan(*, cleanup_cursor=None, job_id: Optional[str] = None, total: int = 0) -> None:
    if cleanup_cursor is not None:
        cleanup_hidden_image_tag_data(cleanup_cursor)
    if job_id:
        mark_job_succeeded(job_id, total=total)


def run_rescan_job(*, root: Path, job_id: Optional[str] = None) -> dict[str, Any]:
    ensure_db_ready()
    images_found = scan_image_paths(root)
    total = len(images_found)
    if job_id:
        touch_job_progress(job_id, done=0, total=total)

    root_str = str(root)
    done = 0
    with db_connect() as conn:
        cur = conn.cursor()
        mark_images_hidden_for_root(cur, root_str)
        existing_by_rel = fetch_existing_images_map(cur, root_str)

        for img_path in images_found:
            process_scanned_image(
                cur=cur,
                root=root,
                root_str=root_str,
                img_path=img_path,
                existing_by_rel=existing_by_rel,
            )

            done += 1
            if job_id and (done % 20 == 0 or done == total):
                touch_job_progress(job_id, done=done, total=total)

        finalize_scan(cleanup_cursor=cur)

    finalize_scan(job_id=job_id, total=total)
    return {"root": root_str, "total": total}


def run_job_safe(*, root: Path, job_id: str) -> None:
    try:
        run_rescan_job(root=root, job_id=job_id)
    except Exception as exc:
        mark_job_failed(job_id, str(exc))
        raise

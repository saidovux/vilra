import uuid
import time
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

@pytest.fixture(scope="session")
def db_available():
    os.environ.setdefault("IMGVIEWER_INLINE_WORKER", "0")
    os.environ.setdefault("IMGVIEWER_THUMB_JOB_MODE", "queue")
    os.environ.setdefault("IMGVIEWER_THUMB_WAIT_MS", "50")
    os.environ.setdefault("IMGVIEWER_THUMB_POLL_MS", "20")
    os.environ.setdefault("IMGVIEWER_THUMB_SYNC_FALLBACK", "0")
    os.environ.setdefault("IMGVIEWER_THUMB_WORKER_EXPECTED", "1")
    from app.repo.db import ensure_db_ready

    try:
        ensure_db_ready()
    except Exception as exc:
        pytest.skip(f"SQLite runtime DB is required for integration tests: {exc}")
    return True


@pytest.fixture()
def client(monkeypatch, db_available):
    monkeypatch.setenv("IMGVIEWER_INLINE_WORKER", "0")
    monkeypatch.setenv("IMGVIEWER_THUMB_JOB_MODE", "queue")
    monkeypatch.setenv("IMGVIEWER_THUMB_WAIT_MS", "50")
    monkeypatch.setenv("IMGVIEWER_THUMB_POLL_MS", "20")
    monkeypatch.setenv("IMGVIEWER_THUMB_SYNC_FALLBACK", "0")
    monkeypatch.setenv("IMGVIEWER_THUMB_WORKER_EXPECTED", "1")
    from app.api.app import app

    with TestClient(app) as c:
        yield c


def _write_tiny_jpeg(path: Path, *, size: tuple[int, int] = (16, 16), mtime: int | None = None) -> None:
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    im = Image.new("RGB", size, (120, 80, 20))
    im.save(path, "JPEG", quality=80)
    if mtime is not None:
        os.utime(path, (mtime, mtime))


def _cleanup_root_data(root_path: str) -> None:
    from app.repo.db import db_connect

    with db_connect() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM jobs WHERE json_extract(payload, '$.root_path') = ?", (root_path,))
        cur.execute("DELETE FROM images WHERE root_path = ?", (root_path,))


def _scan_root(client, root: Path) -> None:
    from app.services.worker import worker_loop

    response = client.post("/api/folder", json={"path": str(root)})
    assert response.status_code == 200, response.text
    job_id = response.json()["job_id"]
    worker_loop(once=True, worker_id=f"pytest-worker-{uuid.uuid4().hex[:6]}", poll_interval=0.01)

    for _ in range(30):
        job = client.get(f"/api/jobs/{job_id}")
        assert job.status_code == 200
        job_body = job.json()["job"]
        if job_body["state"] == "succeeded":
            return
        time.sleep(0.1)
    raise AssertionError("rescan job did not succeed")


def test_smoke_rescan_job_and_pagination_filters(client, tmp_path):
    from app.services.worker import worker_loop
    from app.services.scanner import make_thumb_sync

    root = tmp_path / f"pics-{uuid.uuid4().hex[:6]}"
    _write_tiny_jpeg(root / "cats" / "sleep.jpg")
    _write_tiny_jpeg(root / "cats" / "play.jpg")
    _write_tiny_jpeg(root / "dogs" / "walk.jpg")

    response = client.post("/api/folder", json={"path": str(root)})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    job_id = body["job_id"]

    worker_loop(once=True, worker_id="pytest-worker", poll_interval=0.01)

    job_body = None
    for _ in range(30):
        job = client.get(f"/api/jobs/{job_id}")
        assert job.status_code == 200
        job_body = job.json()["job"]
        if job_body["state"] == "succeeded":
            break
        time.sleep(0.1)
    assert job_body is not None
    assert job_body["state"] == "succeeded"

    page1 = client.get("/api/images", params={"limit": 1, "include_total": 1})
    assert page1.status_code == 200
    p1 = page1.json()
    assert len(p1["items"]) == 1
    assert p1["page"]["total"] == 3
    assert p1["page"]["has_more"] is True
    assert p1["page"]["next_cursor"]

    page2 = client.get("/api/images", params={"limit": 2, "cursor": p1["page"]["next_cursor"], "include_total": 1})
    assert page2.status_code == 200
    p2 = page2.json()
    assert len(p2["items"]) == 2
    assert p2["page"]["total"] == 3

    all_images = client.get("/api/images", params={"sort": "path_asc", "limit": 10, "include_total": 1})
    assert all_images.status_code == 200
    for item in all_images.json()["items"]:
        if item["path"].startswith("cats/"):
            tagged = client.post(f"/api/tag/{item['id']}", json={"tags": ["cats"]})
            assert tagged.status_code == 200, tagged.text

    cats_all = client.get("/api/images", params={"include_tags": "cats", "match_mode": "all", "include_total": 1})
    assert cats_all.status_code == 200
    assert cats_all.json()["page"]["total"] == 2

    missing = client.get("/api/images", params={"include_tags": "missing-tag", "include_total": 1})
    assert missing.status_code == 200
    assert missing.json()["items"] == []
    assert missing.json()["page"]["total"] == 0

    exclude_cats = client.get("/api/images", params={"exclude_tags": "cats", "include_total": 1})
    assert exclude_cats.status_code == 200
    assert exclude_cats.json()["page"]["total"] == 1

    thumb_enqueue = client.post("/api/thumbs/rebuild", json={"stale_only": False})
    assert thumb_enqueue.status_code == 200
    te = thumb_enqueue.json()
    assert te["ok"] is True
    assert te["enqueued"] >= 1
    assert "queued_existing" in te

    first = p1["items"][0]
    t1 = client.get(f"/thumb/{first['id']}")
    assert t1.status_code == 202
    body_202 = t1.json()
    assert body_202["pending"] is True
    assert body_202["job_id"]
    t2 = client.get(f"/thumb/{first['id']}")
    if t2.status_code == 202:
        assert t2.json()["job_id"] == body_202["job_id"]
    else:
        assert t2.status_code == 200

    # simulate worker completion and verify transition 202 -> 200
    src_path = root / first["path"]
    thumb_path = root / first["thumb"]
    assert make_thumb_sync(src_path, thumb_path) is True
    fast_thumb = client.get(f"/thumb-file/{first['id']}.jpg")
    assert fast_thumb.status_code == 200
    assert fast_thumb.headers["content-type"].startswith("image/jpeg")
    t3 = client.get(f"/thumb/{first['id']}")
    assert t3.status_code == 200
    assert t3.headers["content-type"].startswith("image/jpeg")

    status = client.get("/api/status")
    assert status.status_code == 200
    s = status.json()
    assert "workers" in s and "queues" in s
    assert "thumb_queue_depth" in s["queues"]
    assert "thumb_running" in s["queues"]

    _cleanup_root_data(str(root))


def test_tags_and_sessions(client):
    tag_name = f"pytest-{uuid.uuid4().hex[:8]}"
    created = client.post("/api/tags", json={"name": tag_name})
    assert created.status_code == 200
    assert any(t["name"] == tag_name for t in created.json()["tags"])

    renamed = f"{tag_name}-renamed"
    upd = client.patch(f"/api/tags/{tag_name}", json={"name": renamed, "color": "#AABBCC"})
    assert upd.status_code == 200
    assert upd.json()["tag"]["name"] == renamed
    assert upd.json()["tag"]["color"] == "#AABBCC"

    sess_patch = client.patch(
        "/api/session",
        json={
            "search_tags": [renamed],
            "search_mode": "all",
            "tabs": [{"id": "t1", "title": "T", "includeTags": [renamed], "excludeTags": []}],
            "active_tab_id": "t1",
        },
    )
    assert sess_patch.status_code == 200

    sess = client.get("/api/session")
    assert sess.status_code == 200
    s = sess.json()
    assert s["search_mode"] == "all"
    assert renamed.lower() in [x.lower() for x in s["search_tags"]]

    deleted = client.delete(f"/api/tags/{renamed}")
    assert deleted.status_code == 200


def test_image_sort_modes_and_cursor_pagination(client, tmp_path):
    root = tmp_path / f"sort-{uuid.uuid4().hex[:6]}"
    _write_tiny_jpeg(root / "zeta" / "old-small.jpg", size=(16, 16), mtime=1_700_000_000)
    _write_tiny_jpeg(root / "alpha" / "new-large.jpg", size=(80, 80), mtime=1_700_000_200)
    _write_tiny_jpeg(root / "middle" / "mid-medium.jpg", size=(40, 40), mtime=1_700_000_100)
    _scan_root(client, root)

    def collect_paths(sort: str, limit: int = 1) -> list[str]:
        cursor = None
        paths: list[str] = []
        for _ in range(10):
            params = {"sort": sort, "limit": limit, "include_total": 1}
            if cursor:
                params["cursor"] = cursor
            response = client.get("/api/images", params=params)
            assert response.status_code == 200, response.text
            body = response.json()
            assert body["page"]["total"] == 3
            paths.extend(item["path"] for item in body["items"])
            cursor = body["page"]["next_cursor"]
            if not cursor:
                break
        return paths

    newest = client.get("/api/images", params={"sort": "date_desc", "limit": 2})
    assert newest.status_code == 200, newest.text
    n1 = newest.json()
    assert [item["mtime"] for item in n1["items"]] == sorted([item["mtime"] for item in n1["items"]], reverse=True)
    assert n1["page"]["sort"] == "date_desc"
    assert n1["page"]["next_cursor"]

    newest_next = client.get(
        "/api/images",
        params={"sort": "date_desc", "limit": 2, "cursor": n1["page"]["next_cursor"]},
    )
    assert newest_next.status_code == 200, newest_next.text
    ids = [item["id"] for item in n1["items"] + newest_next.json()["items"]]
    assert len(ids) == len(set(ids)) == 3

    path_desc = client.get("/api/images", params={"sort": "path_desc", "limit": 3})
    assert path_desc.status_code == 200, path_desc.text
    paths = [item["path"] for item in path_desc.json()["items"]]
    assert paths == sorted(paths, reverse=True)

    size_desc = client.get("/api/images", params={"sort": "size_desc", "limit": 3})
    assert size_desc.status_code == 200, size_desc.text
    sizes = [item["size"] for item in size_desc.json()["items"]]
    assert sizes == sorted(sizes, reverse=True)

    assert collect_paths("path_asc") == sorted(collect_paths("path_asc"))
    assert collect_paths("path_desc") == sorted(collect_paths("path_desc"), reverse=True)
    date_desc_items = [
        item
        for page_sort in ["date_desc"]
        for item in client.get("/api/images", params={"sort": page_sort, "limit": 3}).json()["items"]
    ]
    assert collect_paths("date_desc") == [item["path"] for item in sorted(date_desc_items, key=lambda item: (-item["mtime"], item["path"].lower(), item["path"], item["id"]))]
    size_asc_items = client.get("/api/images", params={"sort": "size_asc", "limit": 3}).json()["items"]
    assert collect_paths("size_asc") == [item["path"] for item in sorted(size_asc_items, key=lambda item: (item["size"], item["path"].lower(), item["path"], item["id"]))]

    _cleanup_root_data(str(root))


def test_folder_picker_endpoint_uses_native_picker_result(client, monkeypatch):
    import importlib

    api_app = importlib.import_module("app.api.app")

    monkeypatch.setattr(api_app, "_pick_folder_native", lambda: {"path": "/tmp"})
    picked = client.post("/api/folder/pick")
    assert picked.status_code == 200, picked.text
    assert picked.json()["path"] == "/tmp"

    monkeypatch.setattr(api_app, "_pick_folder_native", lambda: {"path": None, "cancelled": True})
    cancelled = client.post("/api/folder/pick")
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["cancelled"] is True

    def unavailable():
        raise RuntimeError("no gui")

    monkeypatch.setattr(api_app, "_pick_folder_native", unavailable)
    missing = client.post("/api/folder/pick")
    assert missing.status_code == 501


def test_scanner_does_not_create_auto_tags_and_keeps_manual_tags(client, tmp_path):
    root = tmp_path / f"tags-{uuid.uuid4().hex[:6]}"
    trip_tag = f"pytest-trips-{uuid.uuid4().hex[:6]}"
    keep_tag = f"pytest-keep-{uuid.uuid4().hex[:6]}"
    trip_file = root / trip_tag / "photo.jpg"
    keep_file = root / keep_tag / "photo.jpg"
    _write_tiny_jpeg(trip_file)
    _write_tiny_jpeg(keep_file)
    _scan_root(client, root)

    tags = {tag["name"] for tag in client.get("/api/tags").json()["tags"]}
    assert trip_tag not in tags
    assert keep_tag not in tags

    created = client.post("/api/tags", json={"name": keep_tag})
    assert created.status_code == 200, created.text
    keep_image = next(
        item for item in client.get("/api/images", params={"sort": "path_asc", "limit": 10}).json()["items"]
        if item["path"] == f"{keep_tag}/photo.jpg"
    )
    tagged = client.post(f"/api/tag/{keep_image['id']}", json={"tags": [keep_tag]})
    assert tagged.status_code == 200, tagged.text

    _scan_root(client, root)
    tags_after_rescan = client.get("/api/tags").json()["tags"]
    tag_names_after_rescan = {tag["name"] for tag in tags_after_rescan}
    assert trip_tag not in tag_names_after_rescan
    assert keep_tag in tag_names_after_rescan
    keep_summary = next(tag for tag in tags_after_rescan if tag["name"] == keep_tag)
    assert keep_summary["auto_count"] == 0
    assert keep_summary["user_count"] == 1

    keep_file.unlink()
    _scan_root(client, root)
    tags_after_cleanup = {tag["name"] for tag in client.get("/api/tags").json()["tags"]}
    assert trip_tag not in tags_after_cleanup
    assert keep_tag in tags_after_cleanup

    _cleanup_root_data(str(root))

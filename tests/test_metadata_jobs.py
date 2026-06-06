import os
import uuid
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest


def _load_module(module_name: str, relative_path: str):
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / relative_path
    spec = spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load spec for {module_path}")
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


metadata_module = _load_module("contracts_metadata_for_tests", "app/contracts/metadata.py")
build_metadata_payload = metadata_module.build_metadata_payload
parse_metadata_payload = metadata_module.parse_metadata_payload
metadata_dedupe_key = metadata_module.metadata_dedupe_key


@pytest.fixture(scope="session")
def db_available():
    os.environ.setdefault("IMGVIEWER_INLINE_WORKER", "0")
    from app.repo.db import ensure_db_ready

    try:
        ensure_db_ready()
    except Exception as exc:
        pytest.skip(f"SQLite runtime DB is required for metadata job tests: {exc}")
    return True


def test_metadata_payload_build_parse_round_trip():
    original = build_metadata_payload(
        image_id="img-meta-1",
        root_path="/data/root",
        path="folder/image.jpg",
    )
    parsed = parse_metadata_payload(original)
    assert parsed == original


def test_metadata_payload_parse_is_strict_about_keys():
    with pytest.raises(ValueError):
        parse_metadata_payload(
            {
                "image_id": "img-meta-2",
                "root_path": "/data/root",
                "path": "a/b.jpg",
                "extra": "nope",
            }
        )


def test_metadata_dedupe_key_prefers_mtime_and_has_fallback():
    assert metadata_dedupe_key("img-meta-3", 123) == "metadata:img-meta-3:123"
    assert metadata_dedupe_key("img-meta-3") == "metadata:img-meta-3"


def test_enqueue_metadata_job_for_image_sets_job_type_and_dedupes(db_available, tmp_path):
    from app.services.metadata_jobs_service import enqueue_metadata_job_for_image

    job_first = enqueue_metadata_job_for_image(
        image_id=uuid.uuid4().hex[:12],
        root_path=str(tmp_path),
        path="some/file.jpg",
        mtime=42,
    )
    assert job_first.get("job_type") == "metadata"
    assert job_first.get("__deduped") is False

    job_second = enqueue_metadata_job_for_image(
        image_id=job_first["payload"]["image_id"],
        root_path=str(tmp_path),
        path="some/file.jpg",
        mtime=42,
    )
    assert job_second.get("job_type") == "metadata"
    assert job_second.get("__deduped") is True


def test_enqueue_metadata_jobs_for_existing_images_counts_queued_existing(db_available, tmp_path, monkeypatch):
    import app.services.metadata_jobs_service as metadata_jobs_service
    from app.services.metadata_jobs_service import enqueue_metadata_jobs_for_existing_images

    image_id = uuid.uuid4().hex[:12]

    def fake_rows(*, limit):
        assert limit == 1
        return [
            {
                "id": image_id,
                "root_path": str(tmp_path),
                "path": "meta/source.jpg",
                "mtime": 777,
            }
        ]

    monkeypatch.setattr(metadata_jobs_service, "_list_metadata_source_rows", fake_rows)

    first = enqueue_metadata_jobs_for_existing_images(limit=1)
    assert first["total"] == 1
    assert first["enqueued"] == 1
    assert first["queued_existing"] == 0

    second = enqueue_metadata_jobs_for_existing_images(limit=1)
    assert second["total"] == 1
    assert second["enqueued"] == 0
    assert second["queued_existing"] == 1

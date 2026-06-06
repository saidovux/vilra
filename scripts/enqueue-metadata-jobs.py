#!/usr/bin/env python3
import argparse
import sys
from pathlib import Path


def detect_repo_root() -> Path:
    current = Path(__file__).resolve().parent
    for candidate in [current, *current.parents]:
        if (candidate / "app").is_dir() and (candidate / "scripts").is_dir():
            return candidate
    raise RuntimeError("Could not detect repo root from script location")


def bootstrap_sys_path() -> Path:
    repo_root = detect_repo_root()
    repo_root_str = str(repo_root)
    if repo_root_str not in sys.path:
        sys.path.insert(0, repo_root_str)
    return repo_root


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Enqueue metadata jobs for existing images")
    parser.add_argument("--limit", type=int, default=None, help="optional limit for images to enqueue")
    return parser.parse_args()


def main() -> None:
    repo_root = bootstrap_sys_path()
    from tagimage_env import load_env_file

    load_env_file(repo_root)
    args = parse_args()

    from app.config import SQLITE_PATH
    from app.services.metadata_jobs_service import enqueue_metadata_jobs_for_existing_images

    result = enqueue_metadata_jobs_for_existing_images(limit=args.limit)
    print(f"repo_root={repo_root}")
    print(f"sqlite={SQLITE_PATH}")
    print(
        f"enqueued={result['enqueued']} "
        f"queued_existing={result['queued_existing']} "
        f"total={result['total']}"
    )


if __name__ == "__main__":
    main()

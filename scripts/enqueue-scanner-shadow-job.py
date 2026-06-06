#!/usr/bin/env python3
import argparse
import os
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


def maybe_reexec_venv(repo_root: Path) -> None:
    venv_python = repo_root / ".venv" / "bin" / "python"
    if not venv_python.is_file():
        return
    current = Path(sys.executable).absolute()
    target = venv_python.absolute()
    if current == target:
        return
    os.execv(str(target), [str(target), *sys.argv])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Enqueue a scanner shadow job")
    parser.add_argument("--root", default=None, help="folder to scan; defaults to saved active session root")
    parser.add_argument("--priority", type=int, default=100, help="job priority")
    return parser.parse_args()


def resolve_root(explicit_root: str | None) -> str:
    if explicit_root:
        return str(Path(explicit_root).expanduser().resolve())

    from app.repo.content import load_session

    session = load_session()
    root = session.get("root_path")
    if not root:
        roots = [item for item in session.get("root_paths") or [] if item]
        root = roots[0] if roots else None
    if not root:
        raise SystemExit("No --root provided and no saved session root found")
    return str(Path(root).expanduser().resolve())


def main() -> int:
    repo_root = bootstrap_sys_path()
    maybe_reexec_venv(repo_root)

    from tagimage_env import ensure_sqlite_path

    sqlite_path = ensure_sqlite_path(repo_root)
    args = parse_args()
    root_path = resolve_root(args.root)
    if not Path(root_path).is_dir():
        raise SystemExit(f"Root folder does not exist: {root_path}")

    from app.services.scanner_shadow_jobs_service import enqueue_scanner_shadow_job

    job = enqueue_scanner_shadow_job(root_path, priority=args.priority)
    print(f"repo_root={repo_root}")
    print(f"sqlite={sqlite_path}")
    print(f"job_id={job.get('id')}")
    print(f"job_type={job.get('job_type')}")
    print(f"root_path={root_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env bash
set -u -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

PYTHON_BIN=""

info() {
  echo "[repair-db] $*"
}

warn() {
  echo "[repair-db] WARN: $*" >&2
}

load_env_file() {
  if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$REPO_ROOT/.env"
    set +a
    info "loaded .env"
  fi
}

pick_python() {
  if [[ -n "${PYTHON:-}" ]]; then
    if command -v "$PYTHON" >/dev/null 2>&1; then
      PYTHON_BIN="$(command -v "$PYTHON")"
      return 0
    fi
    if [[ -x "$PYTHON" ]]; then
      PYTHON_BIN="$PYTHON"
      return 0
    fi
    warn "PYTHON is set but not executable: $PYTHON"
  fi

  if [[ -x "$REPO_ROOT/.venv/bin/python" ]]; then
    PYTHON_BIN="$REPO_ROOT/.venv/bin/python"
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
    return 0
  fi

  warn "Python not found (expected PYTHON, .venv/bin/python, or python3)."
  return 1
}

sqlite_repair_check() {
  "$PYTHON_BIN" - <<'PY'
from app.config import SQLITE_PATH
from app.repo.db import ensure_db_ready, verify_core_tables, verify_job_tables, db_connect

print(f"[python] TAGIMAGE_SQLITE_PATH={SQLITE_PATH}")
SQLITE_PATH.parent.mkdir(parents=True, exist_ok=True)
ensure_db_ready()
core = verify_core_tables()
jobs = verify_job_tables()
with db_connect() as conn:
    row = conn.execute("select 1").fetchone()
print(f"[python] select_1={row[0] if row else None}")
print(f"[python] core_tables={','.join(core)}")
print(f"[python] job_tables={','.join(jobs)}")
PY
}

main() {
  info "repo root: $REPO_ROOT"
  load_env_file
  if ! pick_python; then
    exit 1
  fi
  info "python: $PYTHON_BIN"

  info "SQLite repair/init check"
  if sqlite_repair_check; then
    info "DB repair/check passed."
    exit 0
  fi

  warn "SQLite DB repair/check failed."
  warn "Run:"
  warn "  ./scripts/check-db.sh"
  warn "Default path:"
  warn "  TAGIMAGE_SQLITE_PATH=.run/tagimage.sqlite"
  exit 1
}

main "$@"

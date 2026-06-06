#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMEOUT_SEC=""

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/run-scanner-worker.sh
  ./scripts/run-scanner-worker.sh --timeout 30
USAGE
}

die() {
  echo "[run-scanner-worker] ERROR: $*" >&2
  exit 1
}

pick_python() {
  if [[ -n "${PYTHON:-}" ]]; then
    if [[ -x "$PYTHON" ]]; then
      echo "$PYTHON"
      return 0
    fi
    if command -v "$PYTHON" >/dev/null 2>&1; then
      command -v "$PYTHON"
      return 0
    fi
  fi

  if [[ -x "$REPO_ROOT/.venv/bin/python" ]]; then
    echo "$REPO_ROOT/.venv/bin/python"
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi

  if command -v python >/dev/null 2>&1; then
    command -v python
    return 0
  fi

  return 1
}

read_effective_sqlite_path() {
  local python_bin
  python_bin="$(pick_python)" || die "Python not found; cannot read app.config.SQLITE_PATH"
  "$python_bin" - <<'PY'
from app.config import SQLITE_PATH
print(SQLITE_PATH)
PY
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --timeout)
        [[ $# -ge 2 ]] || die "Missing value for --timeout"
        [[ "$2" =~ ^[0-9]+$ ]] || die "--timeout must be a positive integer"
        [[ "$2" -gt 0 ]] || die "--timeout must be > 0"
        TIMEOUT_SEC="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unexpected argument: $1"
        ;;
    esac
  done
}

main() {
  parse_args "$@"
  cd "$REPO_ROOT"

  if [[ -f "$REPO_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    . "$REPO_ROOT/.env"
    set +a
    echo "[run-scanner-worker] loaded .env"
  fi

  echo "[run-scanner-worker] TAGIMAGE_SQLITE_PATH=$(read_effective_sqlite_path)"

  local cmd=(
    cargo run --release --manifest-path "$REPO_ROOT/rust/scanner-worker/Cargo.toml"
  )

  if [[ -n "$TIMEOUT_SEC" ]]; then
    echo "[run-scanner-worker] timeout=${TIMEOUT_SEC}s"
    set +e
    timeout "${TIMEOUT_SEC}" "${cmd[@]}"
    local code=$?
    set -e
    if [[ "$code" -eq 124 ]]; then
      echo "[run-scanner-worker] timeout reached after ${TIMEOUT_SEC}s (expected for smoke run)"
      return 0
    fi
    return "$code"
  fi

  "${cmd[@]}"
}

main "$@"

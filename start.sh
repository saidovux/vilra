#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RUN_DIR="$SCRIPT_DIR/.run"
LOG_DIR="$SCRIPT_DIR/.logs"
API_PID_FILE="$RUN_DIR/api.pid"
API_BACKEND_FILE="$RUN_DIR/api.backend"
RESCAN_PID_FILE="$RUN_DIR/rescan-worker.pid"
SCANNER_PID_FILE="$RUN_DIR/scanner-worker.pid"
THUMB_PID_FILE="$RUN_DIR/thumb-worker.pid"
METADATA_PID_FILE="$RUN_DIR/metadata-worker.pid"
PORT_FILE="$RUN_DIR/port"

API_LOG="$LOG_DIR/api.log"
RESCAN_LOG="$LOG_DIR/rescan-worker.log"
SCANNER_LOG="$LOG_DIR/scanner-worker.log"
THUMB_LOG="$LOG_DIR/thumb-worker.log"
METADATA_LOG="$LOG_DIR/metadata-worker.log"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

ACTION="start"
FOLDER=""
LOG_TARGET=""
PORT=""
PORT_EXPLICIT=0
OPEN_BROWSER=1
BUILD_RUST=0
RUST_BIN_PATH=""
STRICT_RUST=0

PYTHON_SYS=""
PYTHON_BIN=""
PIP_BIN=""
VENV_DIR="$SCRIPT_DIR/.venv"

THUMB_CMD_KIND=""
THUMB_CMD_PATH=""
THUMB_CMD_CARGO_DIR="$SCRIPT_DIR/rust/thumb-worker"
API_CMD_KIND=""
API_CMD_PATH=""
API_CMD_CARGO_DIR="$SCRIPT_DIR/rust/api-server"
SCANNER_CMD_KIND=""
SCANNER_CMD_PATH=""
SCANNER_CMD_CARGO_DIR="$SCRIPT_DIR/rust/scanner-worker"
METADATA_CMD_KIND=""
METADATA_CMD_PATH=""
METADATA_CMD_CARGO_DIR="$SCRIPT_DIR/rust/metadata-worker"

RUNTIME_ENV_NAMES=(
  TAGIMAGE_SQLITE_PATH
  IMGVIEWER_LEGACY_PYTHON
  IMGVIEWER_RUST_API
  IMGVIEWER_RUST_SCANNER
  IMGVIEWER_METADATA_WORKER
  IMGVIEWER_METADATA_AUTHORITATIVE
  IMGVIEWER_THUMB_JOB_MODE
  IMGVIEWER_INLINE_WORKER
  IMGVIEWER_THUMB_SYNC_FALLBACK
  IMGVIEWER_THUMB_WORKERS
  IMGVIEWER_THUMB_WORKER_EXPECTED
)

usage() {
  cat <<'USAGE'
Usage:
  ./start.sh
  ./start.sh /path/to/images
  ./start.sh start [path]
  ./start.sh foreground [path]
  ./start.sh stop
  ./start.sh restart [path]
  ./start.sh status
  ./start.sh logs [api|rescan|scanner|thumb|metadata]
  ./start.sh open

Flags:
  -p, --port <port>          API port (default: 8000 or PORT env)
      --no-open              Do not open browser
      --build-rust           Build enabled Rust components with cargo build --release
      --rust-bin-path <abs>  Use specific Rust thumb-worker binary
      --strict-rust          Enforce Rust-only thumbnails checks:
                             IMGVIEWER_THUMB_JOB_MODE=queue
                             IMGVIEWER_INLINE_WORKER=0
                             IMGVIEWER_THUMB_SYNC_FALLBACK=0
  -h, --help                 Show this help

Examples:
  ./start.sh
  ./start.sh /data/photos --port 9000
  ./start.sh start --build-rust --strict-rust
  IMGVIEWER_LEGACY_PYTHON=1 ./start.sh start

Env:
  IMGVIEWER_STARTUP_TIMEOUT_SEC  API readiness wait timeout in seconds (default: 20)
  IMGVIEWER_DB_STARTUP_TIMEOUT_SEC  DB readiness wait timeout in seconds (default: 30)
  IMGVIEWER_LEGACY_PYTHON        Use explicit Python legacy runtime defaults when set to 1
  IMGVIEWER_RUST_API             Run Rust api-server instead of Python FastAPI (default: 1)
  IMGVIEWER_METADATA_WORKER      Start Rust metadata-worker (default: 1)
  IMGVIEWER_METADATA_AUTHORITATIVE  Metadata jobs write authoritative events (default: 1)
  IMGVIEWER_RUST_SCANNER         Run Rust scanner-worker for rescan jobs (default: 1)
USAGE
}

die() {
  echo -e "${RED}$*${RESET}" >&2
  exit 1
}

warn() {
  echo -e "${YELLOW}$*${RESET}" >&2
}

info() {
  echo -e "${CYAN}$*${RESET}"
}

ok() {
  echo -e "${GREEN}$*${RESET}"
}

load_env_file() {
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
    ok "[env] loaded .env"
  fi
}

capture_explicit_runtime_env() {
  local name
  for name in "${RUNTIME_ENV_NAMES[@]}"; do
    if [[ -n "$(eval "printf '%s' \"\${$name+x}\"")" ]]; then
      declare -g "EXPLICIT_${name}=1"
      declare -g "SAVED_${name}=$(eval "printf '%s' \"\${$name}\"")"
    else
      declare -g "EXPLICIT_${name}=0"
      declare -g "SAVED_${name}="
    fi
  done
}

restore_explicit_runtime_env() {
  local name marker value_name
  for name in "${RUNTIME_ENV_NAMES[@]}"; do
    marker="EXPLICIT_${name}"
    if [[ "${!marker:-0}" == "1" ]]; then
      value_name="SAVED_${name}"
      export "$name=${!value_name}"
    fi
  done
}

runtime_env_was_explicit() {
  local marker="EXPLICIT_$1"
  [[ "${!marker:-0}" == "1" ]]
}

env_bool_enabled() {
  local raw="${1:-0}"
  case "${raw,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

set_runtime_default_if_unset() {
  local name="$1"
  local value="$2"
  if [[ -z "$(eval "printf '%s' \"\${$name+x}\"")" ]]; then
    export "$name=$value"
  fi
}

set_runtime_profile_default() {
  local name="$1"
  local value="$2"
  if ! runtime_env_was_explicit "$name"; then
    export "$name=$value"
  fi
}

apply_runtime_defaults() {
  restore_explicit_runtime_env

  if env_bool_enabled "${IMGVIEWER_LEGACY_PYTHON:-0}"; then
    set_runtime_profile_default IMGVIEWER_RUST_API 0
    set_runtime_profile_default IMGVIEWER_RUST_SCANNER 0
    set_runtime_profile_default IMGVIEWER_METADATA_WORKER 0
    set_runtime_profile_default IMGVIEWER_METADATA_AUTHORITATIVE 0
    set_runtime_profile_default IMGVIEWER_THUMB_JOB_MODE sync
    set_runtime_profile_default IMGVIEWER_INLINE_WORKER 1
    set_runtime_profile_default IMGVIEWER_THUMB_SYNC_FALLBACK 0
    return 0
  fi

  set_runtime_default_if_unset IMGVIEWER_RUST_API 1
  set_runtime_default_if_unset IMGVIEWER_RUST_SCANNER 1
  set_runtime_default_if_unset IMGVIEWER_METADATA_WORKER 1
  set_runtime_default_if_unset IMGVIEWER_METADATA_AUTHORITATIVE 1
  set_runtime_default_if_unset IMGVIEWER_THUMB_JOB_MODE queue
  set_runtime_default_if_unset IMGVIEWER_INLINE_WORKER 0
  set_runtime_default_if_unset IMGVIEWER_THUMB_SYNC_FALLBACK 0
  set_runtime_default_if_unset IMGVIEWER_THUMB_WORKERS 4
}

is_running_pid() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file="$1"
  if [[ -f "$file" ]]; then
    cat "$file"
  fi
}

write_pid() {
  local file="$1"
  local pid="$2"
  echo "$pid" > "$file"
}

read_saved_port() {
  if [[ -f "$PORT_FILE" ]]; then
    local saved_port
    saved_port="$(cat "$PORT_FILE" 2>/dev/null || true)"
    if [[ "$saved_port" =~ ^[0-9]+$ ]]; then
      echo "$saved_port"
      return 0
    fi
  fi
  return 1
}

write_saved_port() {
  mkdir -p "$RUN_DIR"
  echo "$PORT" > "$PORT_FILE"
}

startup_timeout_sec() {
  local timeout="${IMGVIEWER_STARTUP_TIMEOUT_SEC:-20}"
  if [[ "$timeout" =~ ^[0-9]+$ ]] && [[ "$timeout" -gt 0 ]]; then
    echo "$timeout"
    return 0
  fi
  warn "[start] invalid IMGVIEWER_STARTUP_TIMEOUT_SEC=$timeout, using 20"
  echo "20"
}

db_startup_timeout_sec() {
  local timeout="${IMGVIEWER_DB_STARTUP_TIMEOUT_SEC:-30}"
  if [[ "$timeout" =~ ^[0-9]+$ ]] && [[ "$timeout" -gt 0 ]]; then
    echo "$timeout"
    return 0
  fi
  warn "[start] invalid IMGVIEWER_DB_STARTUP_TIMEOUT_SEC=$timeout, using 30"
  echo "30"
}

metadata_worker_enabled() {
  [[ "${IMGVIEWER_METADATA_WORKER:-0}" == "1" ]]
}

metadata_authoritative_enabled() {
  metadata_worker_enabled && [[ "${IMGVIEWER_METADATA_AUTHORITATIVE:-0}" == "1" ]]
}

metadata_mode() {
  if ! metadata_worker_enabled; then
    echo "not_enabled"
  elif metadata_authoritative_enabled; then
    echo "authoritative"
  else
    echo "shadow"
  fi
}

rust_api_enabled() {
  [[ "${IMGVIEWER_RUST_API:-0}" == "1" ]]
}

api_backend_is_rust() {
  if rust_api_enabled; then
    return 0
  fi

  local api_pid
  api_pid="$(read_pid "$API_PID_FILE" || true)"
  if [[ -z "${api_pid:-}" ]] || ! is_running_pid "$api_pid"; then
    return 1
  fi

  [[ -f "$API_BACKEND_FILE" ]] && [[ "$(cat "$API_BACKEND_FILE" 2>/dev/null || true)" == "rust" ]]
}

api_backend() {
  if api_backend_is_rust; then
    echo "rust"
  else
    echo "python"
  fi
}

write_api_backend() {
  mkdir -p "$RUN_DIR"
  echo "$1" > "$API_BACKEND_FILE"
}

rust_scanner_enabled() {
  [[ "${IMGVIEWER_RUST_SCANNER:-0}" == "1" ]]
}

scanner_backend_is_rust() {
  if rust_scanner_enabled; then
    return 0
  fi

  local scanner_pid
  scanner_pid="$(read_pid "$SCANNER_PID_FILE" || true)"
  [[ -n "${scanner_pid:-}" ]] && is_running_pid "$scanner_pid"
}

scanner_backend() {
  if scanner_backend_is_rust; then
    echo "rust"
  else
    echo "python"
  fi
}

db_ready_once() {
  "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1
from app.repo.db import ensure_db_ready, verify_core_tables, verify_job_tables

ensure_db_ready()
verify_core_tables()
verify_job_tables()
PY
}

wait_for_db_ready() {
  local timeout_sec="$1"
  local elapsed=0

  while [[ "$elapsed" -lt "$timeout_sec" ]]; do
    if db_ready_once; then
      echo "[db] ready"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "[db] not ready (timeout: ${timeout_sec}s)"
  echo "Try:"
  echo "  ./scripts/repair-db.sh"
  echo "  ./scripts/check-db.sh"
  return 1
}

api_health_ready_once() {
  local url="http://127.0.0.1:${PORT}/api/status"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 1 "$url" >/dev/null 2>&1
    return $?
  fi
  "$PYTHON_BIN" -c 'import sys, urllib.request
url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=1):
        pass
except Exception:
    raise SystemExit(1)
raise SystemExit(0)' "$url" >/dev/null 2>&1
}

start_process() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  local workdir="$4"
  shift 4

  local pid
  pid="$(read_pid "$pid_file" || true)"
  if [[ -n "${pid:-}" ]] && is_running_pid "$pid"; then
    echo "[$name] already running pid=$pid"
    return 0
  fi

  mkdir -p "$RUN_DIR" "$LOG_DIR"
  : > "$log_file"

  (
    cd "$workdir"
    nohup setsid "$@" >> "$log_file" 2>&1 < /dev/null &
    echo $! > "$pid_file"
  )

  local new_pid
  new_pid="$(read_pid "$pid_file" || true)"
  sleep 0.3
  if [[ -n "${new_pid:-}" ]] && is_running_pid "$new_pid"; then
    echo "[$name] started pid=$new_pid"
    return 0
  fi

  rm -f "$pid_file"
  echo "[$name] failed to start, check $log_file" >&2
  return 1
}

stop_process() {
  local name="$1"
  local pid_file="$2"
  local pid
  pid="$(read_pid "$pid_file" || true)"

  if [[ -z "${pid:-}" ]]; then
    echo "[$name] not running"
    return 0
  fi

  if ! is_running_pid "$pid"; then
    rm -f "$pid_file"
    echo "[$name] stale pid removed ($pid)"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in {1..25}; do
    if ! is_running_pid "$pid"; then
      rm -f "$pid_file"
      echo "[$name] stopped"
      return 0
    fi
    sleep 0.2
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$pid_file"
  echo "[$name] force stopped"
}

ensure_static_index() {
  mkdir -p "$SCRIPT_DIR/static"

  if [[ -f "$SCRIPT_DIR/index.html" && ! -f "$SCRIPT_DIR/static/index.html" ]]; then
    cp "$SCRIPT_DIR/index.html" "$SCRIPT_DIR/static/index.html"
    ok "[frontend] copied index.html -> static/index.html"
  fi

  if [[ ! -f "$SCRIPT_DIR/static/index.html" ]]; then
    die "[frontend] missing static/index.html"
  fi
}

ensure_python() {
  local ver_ok
  for cmd in python3 python; do
    if command -v "$cmd" >/dev/null 2>&1; then
      ver_ok="$($cmd -c 'import sys; print(sys.version_info >= (3, 9))')"
      if [[ "$ver_ok" == "True" ]]; then
        PYTHON_SYS="$cmd"
        break
      fi
    fi
  done

  if [[ -z "$PYTHON_SYS" ]]; then
    die "Python 3.9+ not found"
  fi

  ok "[python] $($PYTHON_SYS --version)"
}

ensure_venv() {
  if [[ ! -d "$VENV_DIR" ]]; then
    info "[python] creating .venv"
    "$PYTHON_SYS" -m venv "$VENV_DIR"
  fi

  # shellcheck disable=SC1091
  source "$VENV_DIR/bin/activate"
  PYTHON_BIN="$VENV_DIR/bin/python"
  PIP_BIN="$VENV_DIR/bin/pip"

  if [[ ! -x "$PYTHON_BIN" ]]; then
    die "python not found in .venv"
  fi
}

ensure_requirements() {
  local req_file="$SCRIPT_DIR/requirements.txt"
  local stamp_file="$VENV_DIR/.installed_stamp"
  local need_install=0

  if [[ ! -f "$req_file" ]]; then
    die "requirements.txt not found"
  fi

  if [[ ! -f "$stamp_file" || "$req_file" -nt "$stamp_file" ]]; then
    need_install=1
  fi

  if ! "$PYTHON_BIN" -c 'import fastapi, uvicorn, PIL' >/dev/null 2>&1; then
    need_install=1
  fi

  if [[ "$need_install" -eq 1 ]]; then
    info "[python] installing requirements"
    "$PIP_BIN" install -q --upgrade pip
    "$PIP_BIN" install -q -r "$req_file"
    touch "$stamp_file"
    ok "[python] requirements installed"
  else
    ok "[python] requirements are up to date"
  fi
}

ensure_frontend() {
  local bundle="$SCRIPT_DIR/static/dist/app.js"

  if [[ ! -f "$SCRIPT_DIR/package.json" ]]; then
    die "package.json not found"
  fi

  if ! command -v npm >/dev/null 2>&1; then
    die "npm not found; install Node.js/npm"
  fi

  if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
    if [[ -f "$SCRIPT_DIR/package-lock.json" ]]; then
      die "node_modules missing; run: npm ci"
    fi
    die "node_modules missing; run: npm install"
  fi

  info "[frontend] building"
  npm run build:frontend

  if [[ ! -s "$bundle" ]]; then
    die "frontend bundle missing: static/dist/app.js"
  fi

  ok "[frontend] bundle ready"
}

validate_folder() {
  if [[ -z "$FOLDER" ]]; then
    return 0
  fi

  if [[ ! -d "$FOLDER" ]]; then
    die "Folder not found: $FOLDER"
  fi

  FOLDER="$(cd "$FOLDER" && pwd -P)"
  ok "[root] $FOLDER"
}

ensure_port_available() {
  local candidate

  if ! command -v ss >/dev/null 2>&1; then
    return 0
  fi

  if ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"; then
    warn "[port] $PORT is busy, searching next free"
    for candidate in $(seq $((PORT + 1)) $((PORT + 20))); do
      if ! ss -tlnH "sport = :$candidate" 2>/dev/null | grep -q ":$candidate"; then
        PORT="$candidate"
        ok "[port] using $PORT"
        return 0
      fi
    done
    die "no free port found in range $((PORT + 1))..$((PORT + 20))"
  fi
}

open_browser_now() {
  local url="http://127.0.0.1:$PORT"

  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
    return
  fi
  if command -v gnome-open >/dev/null 2>&1; then
    gnome-open "$url" >/dev/null 2>&1 || true
    return
  fi
  if command -v sensible-browser >/dev/null 2>&1; then
    sensible-browser "$url" >/dev/null 2>&1 || true
    return
  fi
  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
    return
  fi

  warn "[open] no browser opener found; open manually: $url"
}

open_browser_delayed() {
  (
    sleep 1.5
    open_browser_now
  ) &
}

prepare_runtime_dependencies() {
  ensure_static_index
  ensure_python
  ensure_venv
  ensure_requirements
  ensure_frontend
}

apply_strict_rust_if_requested() {
  if [[ "$STRICT_RUST" -eq 1 ]]; then
    export IMGVIEWER_THUMB_JOB_MODE=queue
    export IMGVIEWER_INLINE_WORKER=0
    export IMGVIEWER_THUMB_SYNC_FALLBACK=0
    ok "[strict-rust] enabled (queue mode, inline off, sync fallback off)"
  fi
}

apply_rust_scanner_if_requested() {
  if rust_scanner_enabled; then
    if ! runtime_env_was_explicit IMGVIEWER_INLINE_WORKER; then
      export IMGVIEWER_INLINE_WORKER="${IMGVIEWER_INLINE_WORKER:-0}"
    fi
    if ! runtime_env_was_explicit IMGVIEWER_THUMB_JOB_MODE; then
      export IMGVIEWER_THUMB_JOB_MODE="${IMGVIEWER_THUMB_JOB_MODE:-queue}"
    fi
    if [[ "${IMGVIEWER_THUMB_JOB_MODE:-sync}" == "queue" ]] && ! runtime_env_was_explicit IMGVIEWER_THUMB_WORKER_EXPECTED; then
      export IMGVIEWER_THUMB_WORKER_EXPECTED=1
    fi
    ok "[scanner] rust backend enabled (thumb queue mode, inline worker off)"
  fi
}

build_rust_if_requested() {
  if [[ "$BUILD_RUST" -ne 1 ]]; then
    return 0
  fi

  local need_cargo=0
  if [[ -z "$RUST_BIN_PATH" ]]; then
    need_cargo=1
  fi
  if metadata_worker_enabled; then
    need_cargo=1
  fi
  if rust_api_enabled; then
    need_cargo=1
  fi
  if rust_scanner_enabled; then
    need_cargo=1
  fi

  if [[ "$need_cargo" -eq 1 ]]; then
    if ! command -v cargo >/dev/null 2>&1; then
      die "[rust] cargo not found; cannot build rust workers"
    fi
  fi

  if [[ -z "$RUST_BIN_PATH" ]]; then
    info "[thumb-worker] cargo build --release"
    (cd "$SCRIPT_DIR/rust/thumb-worker" && cargo build --release)
  fi

  if metadata_worker_enabled; then
    info "[metadata-worker] cargo build --release"
    (cd "$SCRIPT_DIR/rust/metadata-worker" && cargo build --release)
  fi

  if rust_api_enabled; then
    info "[api-server] cargo build --release"
    (cd "$SCRIPT_DIR/rust/api-server" && cargo build --release)
  fi

  if rust_scanner_enabled; then
    info "[scanner-worker] cargo build --release"
    (cd "$SCRIPT_DIR/rust/scanner-worker" && cargo build --release)
  fi
}

resolve_api_command() {
  API_CMD_KIND=""
  API_CMD_PATH=""

  if ! rust_api_enabled; then
    return 0
  fi

  local default_bin="$SCRIPT_DIR/rust/thumb-worker/target/release/imgviewer-api-server"

  if [[ -x "$default_bin" ]]; then
    API_CMD_KIND="bin"
    API_CMD_PATH="$default_bin"
    return 0
  fi

  if command -v cargo >/dev/null 2>&1; then
    API_CMD_KIND="cargo"
    return 0
  fi

  die "[api] rust api enabled but no rust api-server binary/cargo available"
}

resolve_thumb_command() {
  THUMB_CMD_KIND=""
  THUMB_CMD_PATH=""

  if [[ "${IMGVIEWER_THUMB_JOB_MODE:-sync}" != "queue" ]]; then
    return 0
  fi

  local default_bin="$SCRIPT_DIR/rust/thumb-worker/target/release/imgviewer-thumb-worker"

  if [[ -n "$RUST_BIN_PATH" ]]; then
    if [[ -x "$RUST_BIN_PATH" ]]; then
      THUMB_CMD_KIND="bin"
      THUMB_CMD_PATH="$RUST_BIN_PATH"
      return 0
    fi
    if [[ "$STRICT_RUST" -eq 1 ]]; then
      die "[thumb-worker] --strict-rust enabled but rust binary is not executable: $RUST_BIN_PATH"
    fi
    warn "[thumb-worker] rust binary path is not executable: $RUST_BIN_PATH"
    return 0
  fi

  if [[ -x "$default_bin" ]]; then
    THUMB_CMD_KIND="bin"
    THUMB_CMD_PATH="$default_bin"
    return 0
  fi

  if command -v cargo >/dev/null 2>&1; then
    THUMB_CMD_KIND="cargo"
    return 0
  fi

  if [[ "$STRICT_RUST" -eq 1 ]]; then
    die "[thumb-worker] --strict-rust enabled but no rust worker binary/cargo available"
  fi

  warn "[thumb-worker] rust worker unavailable (no binary/cargo)"
  return 0
}

resolve_metadata_command() {
  METADATA_CMD_KIND=""
  METADATA_CMD_PATH=""

  if ! metadata_worker_enabled; then
    return 0
  fi

  local default_bin="$SCRIPT_DIR/rust/thumb-worker/target/release/imgviewer-metadata-worker"

  if [[ -x "$default_bin" ]]; then
    METADATA_CMD_KIND="bin"
    METADATA_CMD_PATH="$default_bin"
    return 0
  fi

  if command -v cargo >/dev/null 2>&1; then
    METADATA_CMD_KIND="cargo"
    return 0
  fi

  die "[metadata-worker] enabled but no rust worker binary/cargo available"
}

resolve_scanner_command() {
  SCANNER_CMD_KIND=""
  SCANNER_CMD_PATH=""

  if ! rust_scanner_enabled; then
    return 0
  fi

  local default_bin="$SCRIPT_DIR/rust/thumb-worker/target/release/imgviewer-scanner-worker"

  if [[ -x "$default_bin" ]]; then
    SCANNER_CMD_KIND="bin"
    SCANNER_CMD_PATH="$default_bin"
    return 0
  fi

  if command -v cargo >/dev/null 2>&1; then
    SCANNER_CMD_KIND="cargo"
    return 0
  fi

  die "[scanner-worker] rust scanner enabled but no rust worker binary/cargo available"
}

set_start_folder_for_rust_api_if_needed() {
  if ! rust_api_enabled || [[ -z "$FOLDER" ]]; then
    return 0
  fi

  "$PYTHON_BIN" - "$FOLDER" <<'PY'
import sys

from app.services.app_state import get_roots, set_root
from app.services.rescan_jobs_service import enqueue_rescan_job

root = set_root(sys.argv[1])
job = enqueue_rescan_job(str(root))
roots = [str(item) for item in get_roots()]
print(f"[api] rust startup root={root} roots={roots} rescan_job={job['id']}", flush=True)
PY
}

start_api_process() {
  if rust_api_enabled; then
    set_start_folder_for_rust_api_if_needed
    resolve_api_command

    case "$API_CMD_KIND" in
      bin)
        if start_process "api" "$API_PID_FILE" "$API_LOG" "$SCRIPT_DIR" "$API_CMD_PATH" --host 0.0.0.0 --port "$PORT"; then
          write_api_backend "rust"
          return 0
        fi
        return 1
        ;;
      cargo)
        if start_process "api" "$API_PID_FILE" "$API_LOG" "$API_CMD_CARGO_DIR" cargo run --release -- --host 0.0.0.0 --port "$PORT"; then
          write_api_backend "rust"
          return 0
        fi
        return 1
        ;;
      *)
        die "[api] internal error: unknown command kind $API_CMD_KIND"
        ;;
    esac
  fi

  if [[ -n "$FOLDER" ]]; then
    if start_process "api" "$API_PID_FILE" "$API_LOG" "$SCRIPT_DIR" "$PYTHON_BIN" run.py "$FOLDER" --port "$PORT" --no-browser; then
      write_api_backend "python"
      return 0
    fi
    return 1
  else
    if start_process "api" "$API_PID_FILE" "$API_LOG" "$SCRIPT_DIR" "$PYTHON_BIN" -m uvicorn main:app --host 0.0.0.0 --port "$PORT" --log-level warning; then
      write_api_backend "python"
      return 0
    fi
    return 1
  fi
}

start_rescan_worker_process() {
  if rust_scanner_enabled; then
    if [[ -f "$RESCAN_PID_FILE" ]]; then
      stop_process "rescan-worker" "$RESCAN_PID_FILE"
    fi
    start_scanner_worker_process
    return $?
  fi
  if [[ -f "$SCANNER_PID_FILE" ]]; then
    stop_process "scanner-worker" "$SCANNER_PID_FILE"
  fi
  start_process "rescan-worker" "$RESCAN_PID_FILE" "$RESCAN_LOG" "$SCRIPT_DIR" "$PYTHON_BIN" worker.py
}

start_scanner_worker_process() {
  resolve_scanner_command

  case "$SCANNER_CMD_KIND" in
    bin)
      start_process "scanner-worker" "$SCANNER_PID_FILE" "$SCANNER_LOG" "$SCRIPT_DIR" "$SCANNER_CMD_PATH"
      ;;
    cargo)
      start_process "scanner-worker" "$SCANNER_PID_FILE" "$SCANNER_LOG" "$SCANNER_CMD_CARGO_DIR" cargo run --release
      ;;
    *)
      die "[scanner-worker] internal error: unknown command kind $SCANNER_CMD_KIND"
      ;;
  esac
}

start_thumb_worker_process() {
  if [[ "${IMGVIEWER_THUMB_JOB_MODE:-sync}" != "queue" ]]; then
    echo "[thumb-worker] skipped (mode=${IMGVIEWER_THUMB_JOB_MODE:-sync})"
    rm -f "$THUMB_PID_FILE"
    return 0
  fi

  resolve_thumb_command

  case "$THUMB_CMD_KIND" in
    bin)
      start_process "thumb-worker" "$THUMB_PID_FILE" "$THUMB_LOG" "$SCRIPT_DIR" "$THUMB_CMD_PATH"
      ;;
    cargo)
      start_process "thumb-worker" "$THUMB_PID_FILE" "$THUMB_LOG" "$THUMB_CMD_CARGO_DIR" cargo run --release
      ;;
    "")
      if [[ "$STRICT_RUST" -eq 1 ]]; then
        die "[thumb-worker] --strict-rust enabled and rust worker cannot be started"
      fi
      echo "[thumb-worker] skipped (mode=queue, rust worker unavailable)"
      rm -f "$THUMB_PID_FILE"
      ;;
    *)
      die "[thumb-worker] internal error: unknown command kind $THUMB_CMD_KIND"
      ;;
  esac
}

start_metadata_worker_process() {
  if ! metadata_worker_enabled; then
    return 0
  fi

  resolve_metadata_command

  case "$METADATA_CMD_KIND" in
    bin)
      start_process "metadata-worker" "$METADATA_PID_FILE" "$METADATA_LOG" "$SCRIPT_DIR" "$METADATA_CMD_PATH"
      ;;
    cargo)
      start_process "metadata-worker" "$METADATA_PID_FILE" "$METADATA_LOG" "$METADATA_CMD_CARGO_DIR" cargo run --release
      ;;
    *)
      die "[metadata-worker] internal error: unknown command kind $METADATA_CMD_KIND"
      ;;
  esac
}

stop_all() {
  if metadata_worker_enabled || [[ -f "$METADATA_PID_FILE" ]]; then
    stop_process "metadata-worker" "$METADATA_PID_FILE"
  fi
  stop_process "thumb-worker" "$THUMB_PID_FILE"
  if rust_scanner_enabled || [[ -f "$SCANNER_PID_FILE" ]]; then
    stop_process "scanner-worker" "$SCANNER_PID_FILE"
  fi
  stop_process "rescan-worker" "$RESCAN_PID_FILE"
  stop_process "api" "$API_PID_FILE"
  rm -f "$API_BACKEND_FILE"
  rm -f "$PORT_FILE"
}

wait_for_api_ready() {
  local timeout_sec="$1"
  local checks
  local api_pid
  local url="http://127.0.0.1:${PORT}/api/status"

  checks=$((timeout_sec * 2))
  if [[ "$checks" -lt 1 ]]; then
    checks=1
  fi

  for _ in $(seq 1 "$checks"); do
    api_pid="$(read_pid "$API_PID_FILE" || true)"
    if [[ -z "${api_pid:-}" ]] || ! is_running_pid "$api_pid"; then
      echo "[api] exited before becoming ready"
      echo "Tip: ./start.sh logs api"
      if [[ -f "$API_LOG" ]]; then
        echo "----- last 40 lines of api log -----"
        tail -n 40 "$API_LOG" || true
      fi
      return 1
    fi

    if api_health_ready_once; then
      echo "[api] ready"
      return 0
    fi
    sleep 0.5
  done

  echo "[api] failed to become ready (timeout: ${timeout_sec}s)"
  echo "[health] GET $url"
  echo "Tip: ./start.sh logs api"
  return 1
}

verify_strict_thumb_worker_alive() {
  local thumb_pid

  if [[ "$STRICT_RUST" -ne 1 ]]; then
    return 0
  fi
  if [[ "${IMGVIEWER_THUMB_JOB_MODE:-sync}" != "queue" ]]; then
    return 0
  fi

  sleep 0.5
  thumb_pid="$(read_pid "$THUMB_PID_FILE" || true)"
  if [[ -z "${thumb_pid:-}" ]] || ! is_running_pid "$thumb_pid"; then
    echo "[thumb-worker] exited in strict-rust mode"
    echo "Tip: ./start.sh logs thumb"
    if [[ -f "$THUMB_LOG" ]]; then
      echo "----- last 40 lines of thumb-worker log -----"
      tail -n 40 "$THUMB_LOG" || true
    fi
    return 1
  fi
  return 0
}

verify_metadata_worker_alive() {
  local metadata_pid

  if ! metadata_worker_enabled; then
    return 0
  fi

  sleep 0.5
  metadata_pid="$(read_pid "$METADATA_PID_FILE" || true)"
  if [[ -z "${metadata_pid:-}" ]] || ! is_running_pid "$metadata_pid"; then
    echo "[metadata-worker] exited after start"
    echo "Tip: ./start.sh logs metadata"
    if [[ -f "$METADATA_LOG" ]]; then
      echo "----- last 40 lines of metadata-worker log -----"
      tail -n 40 "$METADATA_LOG" || true
    fi
    return 1
  fi
  return 0
}

verify_scanner_worker_alive() {
  local scanner_pid

  if ! rust_scanner_enabled; then
    return 0
  fi

  sleep 0.5
  scanner_pid="$(read_pid "$SCANNER_PID_FILE" || true)"
  if [[ -z "${scanner_pid:-}" ]] || ! is_running_pid "$scanner_pid"; then
    echo "[scanner-worker] exited after start"
    echo "Tip: ./start.sh logs scanner"
    if [[ -f "$SCANNER_LOG" ]]; then
      echo "----- last 40 lines of scanner-worker log -----"
      tail -n 40 "$SCANNER_LOG" || true
    fi
    return 1
  fi
  return 0
}

status_one() {
  local name="$1"
  local pid_file="$2"
  local pid
  pid="$(read_pid "$pid_file" || true)"
  if [[ -n "${pid:-}" ]] && is_running_pid "$pid"; then
    echo "[$name] running pid=$pid"
    return 0
  else
    echo "[$name] stopped"
    return 1
  fi
}

status_python_bin() {
  if [[ -x "$VENV_DIR/bin/python" ]]; then
    echo "$VENV_DIR/bin/python"
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

status_db_line() {
  local py
  if ! py="$(status_python_bin)"; then
    echo "[db] unknown (python not found)"
    return 0
  fi

  if "$py" - <<'PY' >/dev/null 2>&1
from app.repo.db import ensure_db_ready, verify_core_tables, verify_job_tables

ensure_db_ready()
verify_core_tables()
verify_job_tables()
PY
  then
    echo "[db] ready"
  else
    echo "[db] not ready"
  fi
}

status_thumb_line() {
  local mode="${IMGVIEWER_THUMB_JOB_MODE:-sync}"
  local thumb_pid
  thumb_pid="$(read_pid "$THUMB_PID_FILE" || true)"
  if [[ -n "${thumb_pid:-}" ]] && is_running_pid "$thumb_pid"; then
    mode="queue"
  fi
  echo "[thumb] mode=$mode"
}

status_metadata_line() {
  local mode
  local state="stopped"
  local authoritative="false"
  local pid

  mode="$(metadata_mode)"
  if metadata_authoritative_enabled; then
    authoritative="true"
  fi

  pid="$(read_pid "$METADATA_PID_FILE" || true)"
  if [[ -n "${pid:-}" ]] && is_running_pid "$pid"; then
    state="running pid=$pid"
  fi

  echo "[metadata] mode=$mode authoritative=$authoritative state=$state"
}

status_all() {
  local api_running=0
  echo "[api] backend=$(api_backend)"
  echo "[scanner] backend=$(scanner_backend)"
  status_thumb_line
  status_metadata_line
  status_db_line
  if status_one "api" "$API_PID_FILE"; then
    api_running=1
  fi
  if scanner_backend_is_rust; then
    status_one "scanner-worker" "$SCANNER_PID_FILE" || true
    if [[ -f "$RESCAN_PID_FILE" ]]; then
      status_one "rescan-worker" "$RESCAN_PID_FILE" || true
    fi
  else
    status_one "rescan-worker" "$RESCAN_PID_FILE" || true
    if [[ -f "$SCANNER_PID_FILE" ]]; then
      status_one "scanner-worker" "$SCANNER_PID_FILE" || true
    fi
  fi
  status_one "thumb-worker" "$THUMB_PID_FILE" || true
  if [[ -f "$METADATA_PID_FILE" ]]; then
    status_one "metadata-worker" "$METADATA_PID_FILE" || true
  fi

  if command -v curl >/dev/null 2>&1; then
    local health_url="http://127.0.0.1:${PORT}/api/status"
    echo "[health] GET $health_url"
    if ! curl -fsS --max-time 2 "$health_url"; then
      if [[ "$api_running" -eq 1 ]]; then
        echo "[health] unavailable (api process is running, app may still be starting)"
      else
        echo "[health] unavailable (api process is not running)"
      fi
    fi
  else
    echo "[health] curl not found"
  fi
}

tail_log_file() {
  local label="$1"
  local file="$2"
  echo "===== $label ($file) ====="
  if [[ -f "$file" ]]; then
    tail -n 80 "$file"
  else
    echo "(log file not found)"
  fi
}

show_logs() {
  case "$LOG_TARGET" in
    "")
      tail_log_file "api" "$API_LOG"
      if scanner_backend_is_rust; then
        tail_log_file "scanner-worker" "$SCANNER_LOG"
      else
        tail_log_file "rescan-worker" "$RESCAN_LOG"
      fi
      tail_log_file "thumb-worker" "$THUMB_LOG"
      if metadata_worker_enabled || [[ -f "$METADATA_LOG" ]]; then
        tail_log_file "metadata-worker" "$METADATA_LOG"
      fi
      ;;
    api)
      tail_log_file "api" "$API_LOG"
      ;;
    rescan)
      if scanner_backend_is_rust; then
        tail_log_file "scanner-worker" "$SCANNER_LOG"
      else
        tail_log_file "rescan-worker" "$RESCAN_LOG"
      fi
      ;;
    scanner)
      tail_log_file "scanner-worker" "$SCANNER_LOG"
      ;;
    thumb)
      tail_log_file "thumb-worker" "$THUMB_LOG"
      ;;
    metadata)
      tail_log_file "metadata-worker" "$METADATA_LOG"
      ;;
    *)
      die "Unknown logs target: $LOG_TARGET"
      ;;
  esac
}

start_background() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  local timeout_sec
  local db_timeout_sec

  apply_strict_rust_if_requested
  apply_rust_scanner_if_requested
  prepare_runtime_dependencies
  validate_folder
  ensure_port_available
  build_rust_if_requested

  db_timeout_sec="$(db_startup_timeout_sec)"
  if ! wait_for_db_ready "$db_timeout_sec"; then
    exit 1
  fi

  if ! start_api_process; then
    warn "[start] stopping started processes because api failed"
    stop_all
    exit 1
  fi
  if ! start_rescan_worker_process; then
    warn "[start] stopping started processes because scanner backend failed"
    stop_all
    exit 1
  fi

  if ! verify_scanner_worker_alive; then
    warn "[start] stopping started processes because scanner backend failed"
    stop_all
    exit 1
  fi

  if ! start_thumb_worker_process; then
    if [[ "$STRICT_RUST" -eq 1 ]]; then
      if [[ -f "$THUMB_LOG" ]]; then
        echo "----- last 40 lines of thumb-worker log -----"
        tail -n 40 "$THUMB_LOG" || true
      fi
      warn "[strict-rust] stopping started processes because thumb-worker failed"
      stop_all
      exit 1
    fi
  fi

  if ! verify_strict_thumb_worker_alive; then
    warn "[start] stopping started processes because strict-rust thumb-worker failed"
    stop_all
    exit 1
  fi

  if ! start_metadata_worker_process; then
    warn "[start] stopping started processes because metadata-worker failed"
    stop_all
    exit 1
  fi

  if ! verify_metadata_worker_alive; then
    warn "[start] stopping started processes because metadata-worker failed"
    stop_all
    exit 1
  fi

  timeout_sec="$(startup_timeout_sec)"
  if ! wait_for_api_ready "$timeout_sec"; then
    warn "[start] stopping started processes because api is not ready"
    stop_all
    exit 1
  fi

  write_saved_port

  local url="http://127.0.0.1:$PORT"
  echo ""
  ok "[start] app is running in background"
  echo "URL: $url"
  echo "Status: ./start.sh status"
  echo "Logs:   ./start.sh logs"

  if [[ "$OPEN_BROWSER" -eq 1 ]]; then
    open_browser_delayed
  fi
}

start_foreground() {
  local db_timeout_sec

  apply_strict_rust_if_requested
  apply_rust_scanner_if_requested
  prepare_runtime_dependencies
  validate_folder
  ensure_port_available

  db_timeout_sec="$(db_startup_timeout_sec)"
  if ! wait_for_db_ready "$db_timeout_sec"; then
    exit 1
  fi

  local url="http://127.0.0.1:$PORT"
  echo ""
  ok "[foreground] starting API at $url"
  echo "Stop with Ctrl+C"

  if [[ "$OPEN_BROWSER" -eq 1 ]]; then
    open_browser_delayed
  fi

  if [[ -n "$FOLDER" ]]; then
    if rust_api_enabled; then
      set_start_folder_for_rust_api_if_needed
    else
      exec "$PYTHON_BIN" run.py "$FOLDER" --port "$PORT" --no-browser
    fi
  fi

  if rust_api_enabled; then
    resolve_api_command
    case "$API_CMD_KIND" in
      bin)
        exec "$API_CMD_PATH" --host 0.0.0.0 --port "$PORT"
        ;;
      cargo)
        cd "$API_CMD_CARGO_DIR"
        exec cargo run --release -- --host 0.0.0.0 --port "$PORT"
        ;;
      *)
        die "[api] internal error: unknown command kind $API_CMD_KIND"
        ;;
    esac
  fi

  exec "$PYTHON_BIN" -m uvicorn main:app --host 0.0.0.0 --port "$PORT" --log-level warning
}

parse_args() {
  if [[ $# -eq 0 ]]; then
    ACTION="start"
    return 0
  fi

  case "$1" in
    start|stop|restart|status|logs|open|foreground)
      ACTION="$1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      ACTION="start"
      ;;
  esac

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port|-p)
        [[ $# -ge 2 ]] || die "Missing value for $1"
        PORT="$2"
        PORT_EXPLICIT=1
        shift 2
        ;;
      --no-open)
        OPEN_BROWSER=0
        shift
        ;;
      --build-rust)
        BUILD_RUST=1
        shift
        ;;
      --rust-bin-path)
        [[ $# -ge 2 ]] || die "Missing value for --rust-bin-path"
        RUST_BIN_PATH="$2"
        shift 2
        ;;
      --strict-rust)
        STRICT_RUST=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      start|stop|restart|status|logs|open|foreground)
        die "Command should be specified only once"
        ;;
      *)
        if [[ "$ACTION" == "logs" && -z "$LOG_TARGET" && "$1" =~ ^(api|rescan|scanner|thumb|metadata)$ ]]; then
          LOG_TARGET="$1"
          shift
          continue
        fi

        if [[ "$ACTION" =~ ^(start|foreground|restart)$ && -z "$FOLDER" ]]; then
          FOLDER="$1"
          shift
          continue
        fi

        die "Unexpected argument: $1"
        ;;
    esac
  done
}

main() {
  parse_args "$@"

  capture_explicit_runtime_env
  load_env_file
  apply_runtime_defaults
  if [[ "$PORT_EXPLICIT" -ne 1 ]]; then
    if [[ -n "${PORT:-}" ]]; then
      PORT="${PORT}"
    elif read_saved_port >/dev/null 2>&1; then
      PORT="$(read_saved_port)"
    else
      PORT="8000"
    fi
  fi

  case "$ACTION" in
    start)
      start_background
      ;;
    foreground)
      start_foreground
      ;;
    stop)
      mkdir -p "$RUN_DIR" "$LOG_DIR"
      stop_all
      ;;
    restart)
      mkdir -p "$RUN_DIR" "$LOG_DIR"
      stop_all
      start_background
      ;;
    status)
      mkdir -p "$RUN_DIR" "$LOG_DIR"
      status_all
      ;;
    logs)
      mkdir -p "$RUN_DIR" "$LOG_DIR"
      show_logs
      ;;
    open)
      open_browser_now
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"

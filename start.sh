#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RUN_DIR="$SCRIPT_DIR/.run"
LOG_DIR="$SCRIPT_DIR/.logs"
PORT_FILE="$RUN_DIR/port"

API_PID_FILE="$RUN_DIR/api.pid"
SCANNER_PID_FILE="$RUN_DIR/scanner-worker.pid"
THUMB_PID_FILE="$RUN_DIR/thumb-worker.pid"
METADATA_PID_FILE="$RUN_DIR/metadata-worker.pid"

API_LOG="$LOG_DIR/api.log"
SCANNER_LOG="$LOG_DIR/scanner-worker.log"
THUMB_LOG="$LOG_DIR/thumb-worker.log"
METADATA_LOG="$LOG_DIR/metadata-worker.log"

TARGET_DIR="$SCRIPT_DIR/rust/thumb-worker/target/release"
API_BIN="$TARGET_DIR/imgviewer-api-server"
SCANNER_BIN="$TARGET_DIR/imgviewer-scanner-worker"
THUMB_BIN="$TARGET_DIR/imgviewer-thumb-worker"
METADATA_BIN="$TARGET_DIR/imgviewer-metadata-worker"

ACTION="start"
FOLDER=""
PORT=""
PORT_EXPLICIT=0
OPEN_BROWSER=1
BUILD_RUST=0
LOG_TARGET=""

usage() {
  cat <<'USAGE'
Usage:
  ./start.sh [path]
  ./start.sh start [path]
  ./start.sh stop
  ./start.sh restart [path]
  ./start.sh status
  ./start.sh logs [api|scanner|thumb|metadata]
  ./start.sh open

Flags:
  -p, --port <port>  API port (default: 8000 or PORT env)
      --no-open      Do not open the browser
      --build-rust   Rebuild the Rust workspace before start
      --strict-rust  Compatibility flag; runtime is always Rust-only
  -h, --help         Show this help
USAGE
}

die() {
  echo "[vilra] ERROR: $*" >&2
  exit 1
}

load_env_file() {
  if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
  fi
}

is_running_pid() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  local file="$1"
  [[ -f "$file" ]] && cat "$file"
}

start_process() {
  local name="$1"
  local pid_file="$2"
  local log_file="$3"
  shift 3

  local pid
  pid="$(read_pid "$pid_file" || true)"
  if [[ -n "${pid:-}" ]] && is_running_pid "$pid"; then
    echo "[$name] already running pid=$pid"
    return 0
  fi

  mkdir -p "$RUN_DIR" "$LOG_DIR"
  : > "$log_file"
  nohup setsid "$@" >>"$log_file" 2>&1 < /dev/null &
  pid=$!
  echo "$pid" > "$pid_file"

  sleep 0.2
  if ! is_running_pid "$pid"; then
    rm -f "$pid_file"
    echo "[$name] failed to start; see $log_file" >&2
    return 1
  fi
  echo "[$name] started pid=$pid"
}

stop_process() {
  local name="$1"
  local pid_file="$2"
  local pid
  pid="$(read_pid "$pid_file" || true)"

  if [[ -z "${pid:-}" ]]; then
    return 0
  fi
  if ! is_running_pid "$pid"; then
    rm -f "$pid_file"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in {1..20}; do
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

stop_all() {
  stop_process "metadata-worker" "$METADATA_PID_FILE"
  stop_process "thumb-worker" "$THUMB_PID_FILE"
  stop_process "scanner-worker" "$SCANNER_PID_FILE"
  stop_process "api" "$API_PID_FILE"
  rm -f "$PORT_FILE"
}

ensure_frontend() {
  command -v npm >/dev/null 2>&1 || die "npm not found"
  [[ -d "$SCRIPT_DIR/node_modules" ]] || die "node_modules missing; run: npm install"
  npm run build:frontend
  [[ -s "$SCRIPT_DIR/static/dist/app.js" ]] || die "frontend bundle was not created"
  [[ -s "$SCRIPT_DIR/static/app.css" ]] || die "frontend stylesheet was not created"
}

ensure_rust_binaries() {
  command -v cargo >/dev/null 2>&1 || die "cargo not found"

  if [[ "$BUILD_RUST" -eq 1 || ! -x "$API_BIN" || ! -x "$SCANNER_BIN" || ! -x "$THUMB_BIN" || ! -x "$METADATA_BIN" ]]; then
    cargo build --manifest-path "$SCRIPT_DIR/rust/Cargo.toml" --workspace --release
  fi

  [[ -x "$API_BIN" ]] || die "missing $API_BIN"
  [[ -x "$SCANNER_BIN" ]] || die "missing $SCANNER_BIN"
  [[ -x "$THUMB_BIN" ]] || die "missing $THUMB_BIN"
  [[ -x "$METADATA_BIN" ]] || die "missing $METADATA_BIN"
}

validate_folder() {
  [[ -z "$FOLDER" ]] && return 0
  [[ -d "$FOLDER" ]] || die "Folder not found: $FOLDER"
  FOLDER="$(cd "$FOLDER" && pwd -P)"
}

ensure_port_available() {
  command -v ss >/dev/null 2>&1 || return 0
  if ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"; then
    die "port $PORT is already in use"
  fi
}

wait_for_api() {
  command -v curl >/dev/null 2>&1 || die "curl not found"
  local url="http://127.0.0.1:$PORT/api/status"
  for _ in {1..80}; do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      echo "[api] ready"
      return 0
    fi
    local pid
    pid="$(read_pid "$API_PID_FILE" || true)"
    if [[ -z "${pid:-}" ]] || ! is_running_pid "$pid"; then
      tail -n 40 "$API_LOG" 2>/dev/null || true
      return 1
    fi
    sleep 0.25
  done
  tail -n 40 "$API_LOG" 2>/dev/null || true
  return 1
}

set_folder() {
  [[ -z "$FOLDER" ]] && return 0
  local payload
  payload="$(node -e 'process.stdout.write(JSON.stringify({path: process.argv[1]}))' "$FOLDER")"
  curl -fsS \
    -H 'content-type: application/json' \
    -d "$payload" \
    "http://127.0.0.1:$PORT/api/folder" >/dev/null
  echo "[root] $FOLDER"
}

open_browser_now() {
  local url="http://127.0.0.1:$PORT"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  else
    echo "Open manually: $url"
  fi
}

start_all() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  validate_folder
  ensure_port_available
  ensure_frontend
  ensure_rust_binaries

  export IMGVIEWER_METADATA_AUTHORITATIVE="${IMGVIEWER_METADATA_AUTHORITATIVE:-1}"
  export IMGVIEWER_THUMB_WORKER_EXPECTED="${IMGVIEWER_THUMB_WORKER_EXPECTED:-1}"
  export IMGVIEWER_RESCAN_WORKER_EXPECTED="${IMGVIEWER_RESCAN_WORKER_EXPECTED:-1}"

  start_process "api" "$API_PID_FILE" "$API_LOG" "$API_BIN" --host 127.0.0.1 --port "$PORT"
  if ! wait_for_api; then
    stop_all
    die "API did not become ready"
  fi

  start_process "scanner-worker" "$SCANNER_PID_FILE" "$SCANNER_LOG" "$SCANNER_BIN"
  start_process "thumb-worker" "$THUMB_PID_FILE" "$THUMB_LOG" "$THUMB_BIN"
  start_process "metadata-worker" "$METADATA_PID_FILE" "$METADATA_LOG" "$METADATA_BIN"

  set_folder
  echo "$PORT" > "$PORT_FILE"
  echo "[start] Vilra is running at http://127.0.0.1:$PORT"

  if [[ "$OPEN_BROWSER" -eq 1 ]]; then
    open_browser_now
  fi
}

status_process() {
  local name="$1"
  local pid_file="$2"
  local pid
  pid="$(read_pid "$pid_file" || true)"
  if [[ -n "${pid:-}" ]] && is_running_pid "$pid"; then
    echo "[$name] running pid=$pid"
  else
    echo "[$name] stopped"
  fi
}

status_all() {
  status_process "api" "$API_PID_FILE"
  status_process "scanner-worker" "$SCANNER_PID_FILE"
  status_process "thumb-worker" "$THUMB_PID_FILE"
  status_process "metadata-worker" "$METADATA_PID_FILE"

  if [[ -f "$PORT_FILE" ]]; then
    PORT="$(cat "$PORT_FILE")"
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/status" || true
    echo
  fi
}

show_logs() {
  case "$LOG_TARGET" in
    "")
      for pair in "api:$API_LOG" "scanner:$SCANNER_LOG" "thumb:$THUMB_LOG" "metadata:$METADATA_LOG"; do
        local name="${pair%%:*}"
        local file="${pair#*:}"
        echo "===== $name ====="
        tail -n 60 "$file" 2>/dev/null || true
      done
      ;;
    api) tail -n 100 "$API_LOG" 2>/dev/null || true ;;
    scanner) tail -n 100 "$SCANNER_LOG" 2>/dev/null || true ;;
    thumb) tail -n 100 "$THUMB_LOG" 2>/dev/null || true ;;
    metadata) tail -n 100 "$METADATA_LOG" 2>/dev/null || true ;;
    *) die "Unknown log target: $LOG_TARGET" ;;
  esac
}

parse_args() {
  if [[ $# -gt 0 ]]; then
    case "$1" in
      start|stop|restart|status|logs|open)
        ACTION="$1"
        shift
        ;;
    esac
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      -p|--port)
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
      --strict-rust)
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      api|scanner|thumb|metadata)
        if [[ "$ACTION" == "logs" && -z "$LOG_TARGET" ]]; then
          LOG_TARGET="$1"
          shift
        else
          die "Unexpected argument: $1"
        fi
        ;;
      *)
        if [[ "$ACTION" =~ ^(start|restart)$ && -z "$FOLDER" ]]; then
          FOLDER="$1"
          shift
        else
          die "Unexpected argument: $1"
        fi
        ;;
    esac
  done
}

main() {
  load_env_file
  PORT="${PORT:-8000}"
  parse_args "$@"

  if [[ "$PORT_EXPLICIT" -eq 0 && -f "$PORT_FILE" && "$ACTION" =~ ^(status|logs|open|stop)$ ]]; then
    local saved_port
    saved_port="$(cat "$PORT_FILE" 2>/dev/null || true)"
    [[ "$saved_port" =~ ^[0-9]+$ ]] && PORT="$saved_port"
  fi

  case "$ACTION" in
    start) start_all ;;
    stop) stop_all ;;
    restart) stop_all; start_all ;;
    status) status_all ;;
    logs) show_logs ;;
    open) open_browser_now ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"

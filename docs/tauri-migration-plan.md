# Tauri Migration Plan

This document defines architecture guardrails for moving TagImage toward a Tauri desktop app without breaking current behavior.

## 1. Target architecture

Target shape:

```text
Tauri shell
  -> frontend UI
  -> local backend sidecar / Rust backend
  -> local DB
  -> Rust workers for thumbnails/metadata/scanner/hash
```

The migration is incremental. Current development mode uses Rust-first runtime with a local SQLite DB.

## 2. Runtime rule

- Normal development/tests should use the local SQLite DB.
- Packaged desktop runtime should not require a user-installed database server.

## 3. Database direction

Current DB:

- SQLite

Target desktop DB:

- SQLite

Rationale:

- single local file
- easier packaging
- no server process
- no external database server requirement
- suitable for local image index/cache/session/jobs

Important constraint:

- Do not change public API behavior while packaging work proceeds.
- Keep the DB file local and explicit through `TAGIMAGE_SQLITE_PATH`.

## 4. Sidecar strategy

Tauri can run packaged sidecar binaries. Candidate sidecars:

- `tagimage-backend`
- `tagimage-thumb-worker`
- `tagimage-metadata-worker`
- `tagimage-scanner-worker`

Current stage keeps existing `start.sh` development mode.

## 5. Migration order

1. Keep current Rust-first SQLite dev mode stable.
2. Preserve Python as legacy/reference code until parity is no longer needed.
3. Add Tauri shell.
4. Package Rust backend/workers as sidecars or integrate into `src-tauri`.
5. Remove legacy/reference code only after tests and runtime validation.

## 6. What stays reference

`app/services/scanner.py` remains reference implementation until Rust scanner has:

- parity tests
- runtime validation
- fallback path
- same public API behavior

## 7. What not to do

- Do not require an external database server in packaged app.
- Do not delete Python until Rust parity is proven.
- Do not rewrite scanner from scratch without matching Python behavior.
- Do not expose DB directly to frontend as the primary architecture unless explicitly decided.
- Do not change public API endpoints during migration.

## 8. Development modes

Mode A: current dev mode

- `start.sh`
- SQLite file DB
- Rust API
- Rust workers

Mode B: Rust migration dev mode

- Python legacy/reference API
- SQLite file DB
- Rust thumb/metadata workers

Mode C: future Tauri mode

- Tauri shell
- Rust backend/sidecar
- SQLite
- Rust workers

## 9. Immediate next steps

1. Keep runtime smoke tests green on SQLite.
2. Finish cleanup of obsolete external DB code paths.
3. Add Tauri shell implementation.

## 10. Contract priority

If a migration shortcut conflicts with behavior parity, parity wins:

- Keep current API behavior stable.
- Keep Python reference path available until Rust parity is verified.
- Keep SQLite as the only normal runtime DB.

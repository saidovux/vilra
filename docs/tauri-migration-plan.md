# Tauri Runtime Architecture

Vilra now has a Tauri 2 desktop entrypoint while preserving the tested browser development runtime.

## 1. Target architecture

Packaged runtime:

```text
Tauri shell
  -> local Rust API sidecar -> bundled frontend and public HTTP API
  -> scanner-worker sidecar
  -> thumb-worker sidecar (four queue slots by default)
  -> metadata-worker sidecar (authoritative)
  -> SQLite in the OS app-data directory
```

The shell initializes SQLite once before spawning any sidecars, waits for `/api/status` to report `db_ready=true`, then opens the local API URL in the webview. Closing the application terminates all managed sidecars.

## 2. Runtime rule

- Tauri is the normal desktop entrypoint.
- `start.sh` remains the browser development and E2E entrypoint.
- The package has no Python or external database-server runtime dependency.

## 3. Database direction

Desktop DB: SQLite at `<app-data>/tagimage.sqlite` by default.

Rationale:

- single local file
- easier packaging
- no server process
- no external database server requirement
- suitable for local image index/cache/session/jobs

Important constraint:

- Do not change public API behavior while packaging work proceeds.
- An explicit `TAGIMAGE_SQLITE_PATH` can override the desktop location. Relative overrides are resolved inside app-data.

## 4. Sidecar strategy

Tauri packages and starts these existing binaries:

- `imgviewer-api-server`
- `imgviewer-scanner-worker`
- `imgviewer-thumb-worker`
- `imgviewer-metadata-worker`

`scripts/prepare-tauri-sidecars.mjs` builds them for the selected target triple and copies them to Tauri's required suffixed filenames under `src-tauri/binaries/`.

## 5. Frontend And Native APIs

The Rust API serves the same frontend and endpoints in browser and packaged modes. Tauri exposes only the native folder picker to the localhost UI. Gallery, thumbnails, originals, sessions and queue operations continue through the existing API.

## 6. What Stays Reference

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

## 8. Commands

```bash
npm run tauri:dev
npm run tauri:build
```

Browser regression mode remains available through `./start.sh` and `npm run test:e2e`.

## 9. Build Boundary

`npm run tauri:build` performs the frontend and sidecar preparation automatically. Tauri's `TAURI_ENV_TARGET_TRIPLE` hook value is used for target builds; it can be overridden with `TAURI_TARGET_TRIPLE`. The matching Rust target/toolchain must already be installed.

## 10. Contract priority

If a migration shortcut conflicts with behavior parity, parity wins:

- Keep current API behavior stable.
- Keep Python reference path available until Rust parity is verified.
- Keep SQLite as the only normal runtime DB.

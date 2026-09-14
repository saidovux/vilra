# SQLite Runtime Cutover Notes

Vilra uses file-based SQLite in both desktop and browser development runtimes.

What is active:

- Tauri initializes `<app-data>/tagimage.sqlite` before starting the packaged Rust sidecars.
- `start.sh`, `check-db.sh`, and `repair-db.sh` initialize and validate `.run/tagimage.sqlite` for browser development.
- Rust API, scanner-worker, thumb-worker, and metadata-worker open SQLite directly.
- Python legacy/reference modules use `sqlite3` and preserve the existing service/API shapes.
- SQLite stores index metadata, tags, session state, jobs, attempts, events, and relative cache paths.

What is intentionally not included:

- No runtime backend switch.
- No automatic migration from older external DB data.
- No storage of original images, thumbnails, previews, or media bytes in SQLite.

Desktop packaging:

- Tauri is the normal desktop entrypoint and manages the API/scanner/thumb/metadata lifecycle.
- The packaged runtime does not use Python or `start.sh`.
- The same public HTTP API remains between the frontend and Rust backend.

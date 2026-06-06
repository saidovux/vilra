# SQLite Runtime Cutover Notes

Normal TagImage runtime now uses file-based SQLite through `TAGIMAGE_SQLITE_PATH`, defaulting to `.run/tagimage.sqlite`.

What is active:

- `start.sh`, `check-db.sh`, and `repair-db.sh` initialize and validate SQLite.
- Rust API, scanner-worker, thumb-worker, and metadata-worker open SQLite directly.
- Python legacy/reference modules use `sqlite3` and preserve the existing service/API shapes.
- SQLite stores index metadata, tags, session state, jobs, attempts, events, and relative cache paths.

What is intentionally not included:

- No runtime backend switch.
- No automatic migration from older external DB data.
- No storage of original images, thumbnails, previews, or media bytes in SQLite.

Next cleanup stage:

- Remove obsolete external DB code paths that are no longer used by normal runtime.
- Keep public API and worker behavior stable while deleting dead compatibility code.

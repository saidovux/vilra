# Vilra

**V**isual **I**ndexing, **L**inking, **R**etrieval **A**pplication.

Vilra is a local desktop image gallery and tagging application. Images stay on disk; the application stores its index, tags, session state and background-job queue in SQLite.

## Run

Requirements: Node.js/npm, Rust/Cargo and the system dependencies required by Tauri 2.

```bash
npm install
npm run tauri:dev
```

Build a desktop package:

```bash
npm run tauri:build
```

Tauri builds the frontend and three Rust sidecars, initializes the local SQLite database, starts the API/thumbnail/metadata processes and stops them when the application exits.

Python is not part of the project runtime.

## Architecture

- `static/src/main.ts` — frontend logic.
- `static/src/styles.css` — frontend styles.
- `rust/api-server` — local HTTP API, filesystem watcher, startup reconciliation and static frontend server.
- `rust/thumb-worker` — thumbnail generation.
- `rust/metadata-worker` — metadata jobs.
- `rust/crates/tagimage-db` — SQLite schema and data access.
- `rust/crates/tagimage-core` — shared Rust types/helpers.
- `src-tauri` — desktop shell and sidecar lifecycle.

The desktop application uses `tagimage.sqlite` in the OS application-data directory unless `TAGIMAGE_SQLITE_PATH` overrides it.

## Browser development runtime

`start.sh` is a Rust-only development launcher used for browser debugging and Playwright tests:

```bash
./start.sh /path/to/images
./start.sh status
./start.sh logs
./start.sh stop
```

Force a fresh Rust build:

```bash
./start.sh start --build-rust --no-open /path/to/images
```

The browser runtime uses `.run/tagimage.sqlite` by default.

## Frontend

```bash
npm run typecheck:frontend
npm run build:frontend
```

Generated frontend output (`static/dist/` and `static/app.css`) is not committed.

## Tests

Rust workspace tests:

```bash
cargo test --manifest-path rust/Cargo.toml --workspace
```

Browser regression tests:

```bash
npm run test:e2e
```

## Main API

- `POST /api/folder` — add/select a folder and start live indexing.
- `GET /api/events` — live filesystem updates over SSE.
- `GET /api/images` — paginated image list and filters.
- `GET /api/tags` / `POST /api/tags` — tag list and creation.
- `POST /api/tag/{id}` — update user tags for an image.
- `GET /api/session` / `PATCH /api/session` — local UI session.
- `GET /api/folders` — indexed folder tree.
- `POST /api/thumbs/rebuild` — enqueue thumbnail rebuild jobs.
- `GET /api/status` — database/worker/queue status.
- `GET /thumb-file/{id}.jpg` — ready thumbnail fast path.
- `GET /thumb/{id}` — thumbnail fallback/queue endpoint.
- `GET /file/{id}` — original image.

## Image data

For each indexed root Vilra creates only its thumbnail cache next to the images:

```text
photos/
├── .imgindex/
│   └── thumbs/
└── ... original images
```

The index itself is stored in SQLite, not in an `index.json` file.

## Live filesystem indexing

Vilra watches every connected library recursively through Rust `notify` and `notify-debouncer-full`. Create, delete, rename, move and modify events update only the affected SQLite rows and thumbnail jobs, then reach the gallery through SSE. There is no periodic full scan or manual rescan action.

At startup Vilra watches saved roots first and runs one background reconciliation. Existing files are compared by path, size and mtime; unchanged images are not decoded again. An unavailable root is marked offline and its indexed images are retained.

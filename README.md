# Vilra

**V**isual **I**ndexing, **L**inking, **R**etrieval **A**pplication.

Vilra is a local desktop image gallery and tagging application. Images stay on disk; the application stores its index, tags, session state and background-job queue in SQLite.

> **Alpha software:** Vilra 0.2.1 is an early public release. Keep backups of important files and report reproducible problems on [GitHub Issues](https://github.com/saidovux/vilra/issues).

## Install

Download packages from [GitHub Releases](https://github.com/saidovux/vilra/releases).

### Linux x86-64

Download `Vilra_0.2.1_amd64.AppImage`, make it executable, and run it:

```bash
chmod +x Vilra_0.2.1_amd64.AppImage
./Vilra_0.2.1_amd64.AppImage
```

Requirements: a 64-bit Linux desktop with the system libraries required by Electron/AppImage. FUSE may be required by some distributions.

### Windows x64

Download and run `Vilra_Setup_0.2.1_x64.exe` on 64-bit Windows 10 or newer. The alpha installer is not code-signed, so Microsoft Defender SmartScreen may display a warning. Do not disable system protections; verify `SHA256SUMS.txt` and continue only if you trust the download.

Vilra stores its SQLite database and diagnostics in the operating system application-data directory. Original images stay in their selected libraries; `.imgindex/thumbs` contains generated thumbnails.

Supported image formats: JPEG (`.jpg`, `.jpeg`), PNG (`.png`), and WebP (`.webp`).

## Build from source

Requirements: Node.js 22+, npm, stable Rust/Cargo, and platform build tools. Windows packages must be built on native Windows x64 with the MSVC Rust toolchain.

```bash
npm ci
npm run dev
```

Build a Linux x86-64 AppImage:

```bash
npm run build:linux
```

Build a Windows x64 NSIS installer from native Windows:

```powershell
npm run build:win
```

`npm run build` remains an alias for the Linux package. Electron builds the frontend and three platform-native Rust sidecars, initializes the local SQLite database, starts the API/thumbnail/metadata processes, and stops them when the application exits. On Linux the packaged database is at `~/.local/share/app.tagimage.desktop/tagimage.sqlite`; on Windows it is under `%APPDATA%\app.tagimage.desktop\tagimage.sqlite`.

Python is not part of the project runtime.

The repository currently has no project license file. License selection remains an explicit owner decision.

## Architecture

- `static/src/main.ts` — frontend logic.
- `static/src/styles.css` — frontend styles.
- `rust/api-server` — local HTTP API, filesystem watcher, startup reconciliation and static frontend server.
- `rust/thumb-worker` — thumbnail generation.
- `rust/metadata-worker` — metadata jobs.
- `rust/crates/tagimage-db` — SQLite schema and data access.
- `rust/crates/tagimage-core` — shared Rust types/helpers.
- `electron/` — desktop shell, native bridge, diagnostics persistence, and sidecar lifecycle.

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

Desktop runtime checks and a non-GUI smoke run:

```bash
npm run check
npm run smoke
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

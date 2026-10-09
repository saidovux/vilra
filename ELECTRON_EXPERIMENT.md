# Electron experiment

Vilra's Electron runtime is a development-only shell for comparing Chromium with the existing Tauri/WebKitGTK application. It uses the same frontend, Rust API, workers, SQLite database, and backend settings.

Run Electron:

```bash
npm run electron:dev
```

Run Tauri:

```bash
npm run tauri:dev
```

Do not run both desktop runtimes simultaneously. By default they share the Tauri-compatible `app.tagimage.desktop/tagimage.sqlite` database. `TAGIMAGE_SQLITE_PATH` remains available as an explicit override.

Electron packaging and benchmark conclusions are intentionally outside Round 1.

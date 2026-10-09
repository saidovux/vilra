# Electron experiment

Vilra's Electron runtime is an experimental shell for comparing Chromium with the existing Tauri/WebKitGTK application. It uses the same frontend, Rust API, workers, SQLite database, and backend settings.

Run Electron:

```bash
npm run electron:dev
```

Run Tauri:

```bash
npm run tauri:dev
```

Build the standalone Linux x86_64 Electron AppImage:

```bash
npm run electron:build
```

The expected artifact is `dist-electron/Vilra-Electron_0.2.0_amd64.AppImage`. Validate its packaged runtime without opening a window:

```bash
./dist-electron/Vilra-Electron_0.2.0_amd64.AppImage --smoke
```

Do not run both desktop runtimes simultaneously. By default they share the Tauri-compatible `app.tagimage.desktop/tagimage.sqlite` database. `TAGIMAGE_SQLITE_PATH` remains available as an explicit override.

No benchmark conclusions have been made yet.

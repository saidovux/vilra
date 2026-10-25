# Windows x64 build

Use a native x64 Windows environment with Node.js 22+, npm, the stable MSVC Rust toolchain, and the Visual C++ build tools.

```powershell
npm ci
npm run electron:check
npm run build:win
```

The build produces `dist-electron\Vilra_Setup_0.2.1_x64.exe`. The three Rust sidecars are compiled natively as `.exe` files and packaged with the frontend. Do not use a normal Linux build to cross-compile the Windows release.

For development, use `npm run electron:dev`. `run.ps1` remains a browser-only debug helper and is not part of the release package.

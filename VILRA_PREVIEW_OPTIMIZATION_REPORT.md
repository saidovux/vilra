# Vilra Preview Optimization Report

## Starting state

- Branch: `main`
- Starting HEAD: `2520f43c076dbf1cf4bf31e515fcc182a6eb5161` (`fast-gallery`)
- Starting worktree: clean
- Production runtime: Tauri AppImage on Linux / WebKitGTK `2.52.6`
- CPU: Intel Core i3-2310M, 2 cores / 4 threads, 2.10 GHz
- RAM: 7.7 GiB, no swap
- Phase 4A TanStack virtual masonry was retained unchanged.

## Old architecture

The successful preview path was:

`/file/:id` -> `fetch()` -> `Blob` -> object URL -> `HTMLImageElement` -> natural-size canvas -> `drawImage()` -> `canvasCache` -> modal canvas -> another `drawImage()`.

The cache retained up to nine natural-size canvases. Opening an image also started full-original preloads for nearby images. A 16000x9000 RGBA surface alone has a theoretical capacity of about 549 MiB; this is a capacity estimate, not measured process memory.

The previous Chromium benchmark measured 4.76 seconds from click to a visible 144 MP preview while the first original HTTP response took about 354 ms. This localized most of the old delay after delivery, in decode/allocation/canvas-copy/presentation work, without proving one individual operation was solely responsible.

## New architecture

The normal successful path is now:

`click` -> immediate modal shell and metadata -> canonical thumbnail -> native `<img src="/file/:id">` -> original replaces thumbnail on `load`.

- There is no preview canvas and no natural-resolution `drawImage()`.
- There is no explicit `HTMLImageElement.decode()` call.
- Zoom, pointer-centered wheel/click zoom, pan, bounds, resize, keyboard navigation, tags, metadata, and original link remain available.
- Original failures use an error-only `HEAD /file/:id` request to retain distinct 404 and 422 behavior; successful originals stay on the direct native image path.
- Closing hides the modal and invalidates callbacks immediately. Native source detachment happens after the close paint so resource cleanup cannot delay the first close frame unnecessarily.

## Resource lifecycle

- The preview requests its own canonical thumbnail URL and does not borrow a virtualized card's temporary object URL.
- A fallback thumbnail object URL is scoped to one preview generation and revoked on completion, navigation, or close.
- Every open/close increments a generation token. Old `load`/`error` handlers are removed before replacement, so late A/B events cannot overwrite C or reopen a closed modal.
- The original is held only by the active native image element. Its handlers and source are released after close; navigation replaces the source.
- `canvasCache`, its nine-entry limit, and natural-size canvas invalidation paths were removed.
- Automatic full-original neighbor preloading was removed. Browser-managed HTTP/resource caching is the only original cache.

## Benchmarks

Raw artifacts and the reusable runner are in:

`.run/benchmarks/preview-native-20260924T143447Z/`

Run again with:

```bash
.run/benchmarks/preview-native-20260924T143447Z/run-benchmark.sh
```

The runner launches the fresh AppImage, copies the production SQLite DB into the artifact directory, clears jobs only in that copy, waits for both roots and an idle queue, runs the browser benchmark, and stops the full AppImage process family. User originals are only read through the production Rust API.

The before/after presentation numbers below use the same Playwright/Chromium methodology against the AppImage API. They are useful architecture comparisons, but they are not claimed as WebKitGTK presentation timings.

| Image | Old first visible | New shell | New thumbnail | New original visible | Change in first original |
|---|---:|---:|---:|---:|---:|
| Small, 720x1280 | 304.3 ms | 15.0 ms | Original won first paint | 186.2 ms | -38.8% |
| Normal, 1920x1270 | 239.7 ms | 25.9 ms | Original won first paint | 194.6 ms | -18.8% |
| Large, 4672x7008 | 1554.6 ms | 10.3 ms | 63.4 ms | 470.8 ms | -69.7% |
| 144 MP, 16000x9000 | 4762.9 ms | 9.8 ms | 46.1 ms | 490.5 ms | -89.7% |

For small and normal images, the original became paint-ready before a distinct thumbnail-only frame was observed. The shell still appeared in 15.0/25.9 ms. Large and 144 MP images showed the intended progressive thumbnail at 63.4/46.1 ms.

First-open original resource timing:

| Image | Request start | Resource duration | Response end -> visible |
|---|---:|---:|---:|
| Small | 25.4 ms | 30.5 ms | 144.0 ms |
| Normal | 42.1 ms | 50.6 ms | 122.8 ms |
| Large | 18.3 ms | 120.9 ms | 340.6 ms |
| 144 MP | 14.1 ms | 440.8 ms | 40.4 ms |

Warm reopen comparison:

| Image | Old second visible | New second visible |
|---|---:|---:|
| Small | 106.7 ms | 61.3 ms |
| Normal | 154.9 ms | 328.6 ms |
| Large | 667.6 ms | 579.7 ms |
| 144 MP | 443.1 ms | 533.4 ms |

The old warm path benefited from retained full-resolution canvases. The new path deliberately trades that unbounded decoded-surface retention for browser-managed resources, so warm results vary and medium/144 MP warm reopen is slower in this run. Every transition issued exactly one original request, issued no neighbor requests, and created zero preview canvases.

ArrowRight original-visible measurements were 251.3 ms (normal), 408.1 ms (large), and 944.4 ms (144 MP), with exactly one original request per destination.

The immediate-close stress measurement in Chromium still reached 2.78 seconds after the 144 MP load. Source release no longer runs before modal hiding; the remaining delay appears associated with the browser's huge-image presentation work. It should be checked manually in WebKitGTK before adding a more complex derivative pipeline.

## Memory

- Measured settled AppImage/WebKitGTK process-family idle PSS: 371,682 KiB (about 363 MiB).
- WebKit process-family PSS with normal preview open: **NOT MEASURED**.
- WebKit process-family PSS with 144 MP preview open: **NOT MEASURED**.
- WebKit PSS after close/repeated navigation: **NOT MEASURED**.

`tauri-driver`, `WebKitWebDriver`, `xdotool`, `wmctrl`, and `ydotool` were unavailable. There was no safe way to drive the production WebKit window through the required preview states, so Chromium memory was not substituted. The code-level improvement is nevertheless concrete: two canvas copies, up to nine retained natural-size canvases, and neighbor original decodes no longer exist. The 549 MiB RGBA figure remains theoretical, not measured RAM.

## Experiments

Native `<img>` met the primary decision gate: shell/thumbnail is immediate and the first 144 MP original improved from 4.76 s to about 0.49 s in the comparable Chromium benchmark. Therefore no explicit `decode()`, `createImageBitmap`, medium derivative, worker decoder, or tile pipeline was added. Adding those without production WebKit evidence would increase complexity without a demonstrated need.

## Regressions and validation

- `npm run typecheck`: passed.
- `npm run build:frontend`: passed.
- `npm run test:e2e`: 22 passed, including Phase 4A virtualization and three new progressive-preview/race tests.
- Focused preview/original/422 suite: 9 passed.
- `cargo fmt --all --manifest-path rust/Cargo.toml --check`: passed.
- `cargo check --manifest-path rust/Cargo.toml --workspace`: passed.
- `cargo test --manifest-path rust/Cargo.toml --workspace`: passed, 87 tests.
- Tauri formatting: passed.
- Tauri check/tests with isolated `CARGO_TARGET_DIR`: passed, 2 tests.
- `npm run tauri:prepare`: passed.
- Fresh AppImage build: passed.
- Fresh AppImage launch: `db_ready=true`, `ready=true`, both roots online and settled, queue idle.
- `git diff --check`: passed.

The default Tauri Cargo cache still contains stale absolute paths from an older checkout, so the established isolated `CARGO_TARGET_DIR` was used. No destructive cache cleanup was performed.

## AppImage

- Path: `.run/benchmarks/preview-native-20260924T143447Z/appimage-target/release/bundle/appimage/Vilra_0.1.0_amd64.AppImage`
- Size: 111,532,536 bytes (about 106.4 MiB)
- SHA256: `5175c735105a313aadda95b1193d9af8e24021a70e4ded40d21d661168460536`

## Conclusion

Yes: Vilra can replace the full-resolution canvas pipeline with a thumbnail-first native image pipeline. The perceived opening path is now immediate, the first 144 MP original improved by about 89.7% in the comparable benchmark, and the largest avoidable canvas/cache/preload costs are gone.

Phase 4B should stop at the simple native implementation. The remaining concern is production-WebKit close/presentation behavior for huge images, which needs direct manual or future WebKit automation evidence before a medium derivative or other complex renderer is justified.

# Vilra Round 2: Ready-Gallery Long-Scroll Benchmark

## Scope

This was a measurement-only run. No application source files were changed; this report is the only tracked change.

- Repository: `main`
- HEAD: `3a3441a7ce29152f19efa80e2be0baa1ec99f600`
- Library input: isolated copy under `.run/round2/library`
- Input snapshot: 8,879 supported images, 20,740,037,575 bytes
- Runtime: Tauri/WebKitGTK, X11, 760x722 viewport
- Scroll driver: native X11 wheel events, 4,440 events over 600 seconds

The source library was not passed to any benchmark process. The 8,879-file snapshot and its SQLite golden state were reused for every run. The original source tree had no metadata changes for the files shared with the snapshot; six newer files appeared in the source tree after the snapshot and were intentionally outside this benchmark input.

## Runs

| Run | Artifact | Duration | Result |
| --- | --- | ---: | --- |
| normal-cold | `.run/round2/artifacts/normal/Vilra_0.1.1_round2_normal_amd64.AppImage` | 600 s | ready, 8,879/8,879, queues empty |
| normal-warm | same normal artifact with warmed profile | 600 s | ready, 8,879/8,879, queues empty |
| diagnostic-cold | `.run/round2/artifacts/diagnostic/Vilra_0.1.1_round2_diagnostic_amd64.AppImage` | 600 s | ready, 8,879/8,879, queues empty |
| stable-cold | `rust/thumb-worker/target/release/bundle/appimage/Vilra_0.1.1_amd64.AppImage` | 600 s | ready, 8,879/8,879, queues empty |

All runs used a separate SQLite copy, separate XDG profile, and separate port. All app processes were stopped after each run.

## Diagnostic results

The diagnostic run produced:

`.run/round2/profiles/diagnostic-cold/data/app.tagimage.desktop/diagnostics/long-scroll-1791364794-396-94974-1.json`

- 3,216 image metadata entries loaded at the deepest observed point.
- Maximum visible index: 3,136.
- Maximum mounted cards: 64.
- 67 pagination requests: 67 successful, 0 failed, 0 stale.
- `/api/images` server timing: mean 117.2 ms, approximate p50 100 ms, approximate p95 250 ms, maximum 449.6 ms.
- End-to-end pagination timing: mean 150.9 ms, approximate p50 125 ms, approximate p95 300 ms, maximum 956 ms.
- Thumbnail primary loads: 3,524 started, 3,524 successful, 0 errors.
- Thumbnail fallback requests: 0, including 0 HTTP 202 responses.
- Visible cards not ready on first visibility: 13; mean visible-to-load latency 159.5 ms, maximum 196 ms.
- `renderVirtualGalleryRange`: mean 8.2 ms, approximate p50 8 ms, approximate p95 25 ms, maximum 86 ms.
- Virtual gallery count updates: mean 8 ms, approximate p95 16 ms, maximum 18 ms.

The frame-interval metric is a browser-side scheduling proxy, not a paint trace. It had late outliers up to 2.7 seconds, so it is not sufficient to claim a frame-pacing regression by itself. Resource Timing also reported long-lived entries and one full-buffer event; those values are not visible-image latency.

## Normal versus stable artifact

The older stable AppImage completed the same native scroll workload and had no functional failure. External process telemetry was close between the artifacts. In the late window, the stable control had approximately 540 MiB WebKit process RSS versus approximately 563 MiB for the normal cold run; the normal warm run was approximately 535 MiB. This is a modest memory difference, not a demonstrated gallery correctness regression.

The stable artifact has no equivalent internal diagnostic report, so the detailed pagination, thumbnail, and render measurements above come from the diagnostic build only. The normal cold and warm runs had the same final queue and readiness state and no runtime error or lock messages.

## Runtime and queue state

Each run ended with:

- `ready=true`
- `done=8879`, `total=8879`
- `thumb_queue_depth=0`
- `thumb_running=0`
- `metadata_running=0`
- `syncing=false`
- zero active jobs in the per-run SQLite database

The golden database passed SQLite `PRAGMA integrity_check` with `ok`. Preparation-only worker recovery messages reported zero recovered jobs during benchmark runs; there were no `database is locked`, fatal, thumbnail fallback, or HTTP 202 messages in the normal/diagnostic logs.

## Validation

- `npm run typecheck`: passed
- `npm run build:frontend`: passed
- `npm run test:e2e`: passed, 32 tests
- `git diff --check`: passed
- Worktree after validation: clean before adding this report

## Conclusion

The ready-gallery long-scroll path is functionally stable in the isolated workload. The measurements do not show a systematic pagination, thumbnail, or virtual-gallery slowdown with depth. There are browser scheduling/resource-timing outliers that should be treated as diagnostic limitations until reproduced with a paint-level trace.

Round 3 can proceed. No Round 4 performance fix is justified by this run alone.

## Isolation caveat

An early unsupported `--version` probe of the stable worker binary started that worker against the repository default `.run/tagimage.sqlite` before the isolated benchmark runs were established. It was stopped immediately and did not receive a user image root. The benchmark runs themselves used only isolated databases and profiles; the default database should be treated as potentially touched by that probe.

# Vilra Long-Scroll Diagnostics Report

## 1. Tested HEAD

- Source-of-truth starting HEAD: `3be6ec377c829d25a410df90390608a9f08acf60`
- Base `origin/main`: `3f9aaaf09f026ae2e0fa52d6282cf585655835d2`
- Product version: `0.1.1` (unchanged)
- Production stack: Tauri, WebKitGTK, TypeScript, TanStack Virtual, SQLite

No root cause for the reported periodic slowdown is claimed in this report. Phase 5D creates a bounded trace that can correlate a real user slowdown with gallery activity.

## 2. Working branch and initial working tree

- Branch: `diagnostics/long-scroll-20261002`
- Upstream: `origin/diagnostics/long-scroll-20261002`
- Initial worktree: clean
- Initial branch delta: only the unconnected `static/src/gallery-diagnostics.ts` draft
- Commit/push performed: no

## 3. Diagnostic architecture

The diagnostic module is opt-in and observes the existing gallery pipeline. It does not alter `PAGE=48`, `GALLERY_OVERSCAN=20`, TanStack geometry, HTTP caching, thumbnail worker count, thumbnail quality, or pagination scheduling.

It records three bounded layers:

1. Complete-session counters and fixed-bucket latency histograms.
2. Two-second timeline intervals for correlation.
3. A bounded tail of important failures and long operations.

Internal image IDs are used only to associate one mounted card lifecycle with callbacks. They are never serialized.

## 4. Problems fixed in the existing diagnostic draft

The draft was replaced within the diagnostic module because it:

- started recording when the panel was opened;
- destroyed access to results when closed;
- retained only the last 300 values and called them session percentiles;
- ran requestAnimationFrame continuously outside active scrolling;
- counted every repeated `202` as if it were another affected image;
- did not separate stale, HTTP, parse, abort and network page outcomes;
- had no session generation guard;
- did not freeze a report at stop;
- assumed Resource Timing fields were available;
- exported the full User-Agent;
- had no manual slowdown marker.

The new module explicitly handles all of these cases.

## 5. Session lifecycle

The implemented states are:

`OFF -> RECORDING -> STOPPED -> EXPORTED`

- Opening or hiding the panel does not start or stop recording.
- Starting a session increments a generation and clears every prior aggregate.
- Stopping records the end time, drains `PerformanceObserver.takeRecords()`, records pending work, cancels timers/status fetch, disconnects observers, and freezes one JSON string.
- Late callbacks check state and generation and cannot modify a stopped or newer report.
- Export does not rebuild or mutate the snapshot.
- Starting a new recording replaces the old snapshot intentionally.

## 6. Timeline and timestamp model

Frontend durations use only `performance.now()`. All exported event times are relative to the session start. `Date.now()` is used only indirectly through an ISO calendar start label.

Resource Timing `startTime` is converted from document-relative time to session-relative time. Entries that started before recording are not attributed to the trace. `Server-Timing: api-images;dur=...` is stored only as a duration and never treated as a synchronized timestamp.

## 7. Pagination metrics

Both refresh and cursor pages are tracked. Successful pages record:

- request to response;
- response body/JSON parsing;
- response-to-`ImageItem` mapping;
- stable-ID deduplication;
- array update/copy;
- pre-virtualizer wait where applicable;
- virtualizer update;
- complete frontend duration;
- backend `api-images` Server-Timing duration.

Outcomes are separated into success, HTTP failure, parse failure, network failure, abort and stale response. Stage histograms are committed only for successful current-generation pages, so stale/failed pages do not pollute successful processing distributions.

The report separately exports loaded metadata count, maximum mounted index, and maximum genuinely visible index.

## 8. Thumbnail metrics

Each card mount creates a new lifecycle. The trace distinguishes:

- primary request start, success and error;
- fallback HTTP `200`, repeated `202`, terminal `422`, other status and network error;
- fallback attempt count;
- mount lifecycles that encountered one or more `202` responses;
- affected lifecycles that later recovered;
- failed lifecycles;
- first viewport entry and readiness at that point;
- mount/request-to-load and visible-to-load latency.

Viewport entry is derived from TanStack virtual item geometry on range updates. It is not inferred only at mount time, so an overscan card entering the viewport later is recorded correctly. `img.complete && img.naturalWidth > 0` prevents failed images from being classified as ready. No `decode()` call was added.

## 9. Queue metrics

While recording, the module performs a read-only queue sample approximately every seven seconds. It exports only:

- thumbnail queue depth;
- running thumbnail jobs;
- stale running thumbnail jobs;
- running metadata jobs;
- status request latency.

Only one diagnostic status request can be active. Stop or a new session aborts the previous request. Generation checks reject late responses. Root paths and all unrelated status fields are discarded.

## 10. Frame interval metrics

requestAnimationFrame sampling starts only when TanStack reports active scrolling. It stops after a short active-scroll tail. Samples are discarded while the document is hidden, the gallery view is inactive, preview is open, graph is open, or settings cover the gallery.

The result is named `frame interval proxy`. It is not called paint latency and does not attribute a long interval to JavaScript, layout or the compositor. The histogram includes the whole recording, while two-second intervals retain anomaly counts and maximum gaps for marker correlation.

## 11. Performance API support

The module checks both `PerformanceObserver` and `PerformanceObserver.supportedEntryTypes` before observing resources. Unsupported observers and unavailable response status/size fields are exported as `UNSUPPORTED`, never as zero.

Blob URLs are excluded from backend network statistics. No `performance.clearResourceTimings()` call is made and the global buffer is not enlarged.

## 12. Resource Timing coverage and limitations

Observed thumbnail resources retain only numeric timing/status/size aggregates. URLs are parsed internally only to identify thumbnail traffic and are then discarded.

The TypeScript/browser callback contract available to Vilra does not expose a reliable full-session dropped-entry count. Buffer-full events are counted, and coverage is therefore conservatively exported as `PARTIAL` whenever Resource Timing is supported. Zero transfer size is explicitly not interpreted as proof of a cache hit; `304` is not treated as a full-body transfer.

## 13. Data retention policy

- Complete-session distributions use fixed histogram buckets, not a last-N sample.
- Detailed intervals target two-second resolution and are capped at 1,800.
- Older unprotected intervals are compacted into bounded coarse intervals.
- Coarse history is capped at 720 entries and compacted again if required.
- A seven-interval window around each of up to 50 manual markers is protected from detailed compaction.
- Important error/slow-operation history is a 600-entry tail.

The synthetic long trace observed more than 300 resource events and retained its early slow-resource event and initial timeline interval.

## 14. Privacy of exported JSON

The export contains no absolute paths, filenames, original image IDs, tags, roots, request URLs, response bodies, SQLite rows or full User-Agent.

An E2E fixture deliberately uses `synthetic-private`, `/secret-root`, `private-name`, and private tags. None appears in the exported JSON. The only permitted identifying context is build/session generation, relative numeric indexes, viewport size and aggregate timing/counter data.

Clipboard export is attempted first. If unavailable, a read-only selected textarea provides a manual fallback without adding Tauri filesystem permissions or native commands.

## 15. Diagnostic overhead

Raw artifacts are stored in:

`.run/benchmarks/long-scroll-diagnostics-20261003/`

The controlled Playwright/Chromium comparison alternated three OFF and three RECORDING runs over the same 5,040-item synthetic gallery. It is not a WebKitGTK performance result.

| Metric | OFF median | RECORDING median |
| --- | ---: | ---: |
| Fixed scroll duration | 3,389.9 ms | 3,479.6 ms |
| External frame interval p95 | 66.7 ms | 66.7 ms |
| Pagination requests | 8 | 8 |
| Thumbnail requests | 375 | 385 |
| Mounted cards at end | 62 | 65 |
| DOM nodes at end | 776 | 811 |
| Diagnostic status requests | 0 | 1 |
| Retained report JSON | 0 | 48,146 bytes |

Duration was 2.6% higher in the recording median, while external frame p95 and pagination request count were unchanged. The recording median issued ten more thumbnail requests because reached depth and mounted range varied between runs, so this is not attributed to the diagnostic module. No material diagnostic regression was demonstrated, retained data stayed below 55 KB for these short traces, and status polling matched its seven-second policy.

## 16. E2E results

- Dedicated diagnostics suite: 5/5 passed.
- Full Playwright suite: 30/30 passed.
- OFF state: no diagnostic timer, observer, status request or permanent animation loop.
- Independent sessions and immutable stopped snapshots: passed.
- Pending old-generation status response: passed.
- Cached ready card and failed card classification: passed.
- Repeated `202` attempts vs one affected lifecycle: passed.
- Remount and overscan-to-viewport lifecycle: passed.
- Hidden-document frame exclusion: passed.
- More than 300 resource events with early-event retention: passed.
- Privacy and export: passed.
- Unsupported PerformanceObserver: passed.
- Manual marker/timeline association: passed.

## 17. WebKitGTK version and smoke test

`pkg-config` and the installed package report WebKitGTK `2.52.6` (`webkit2gtk-4.1 2.52.6-1`). The running diagnostic AppImage mapped `libwebkit2gtk-4.1.so.0` and `libjavascriptcoregtk-4.1.so.0` from its mounted AppDir. The mapped WebKit library and `/usr/lib/libwebkit2gtk-4.1.so.0` have the same ELF build ID, `e22b04fde63cf5250fbe835348c4ad679b7e7d4d`, confirming the packaged runtime corresponds to the installed 2.52.6 build.

The isolated smoke used its own SQLite database, XDG config/cache/data directories, fixture root, and port `18879`. The API reached `db_ready=true`, `ready=true`, indexed one fixture, and launched all three sidecars. The instance and listener were stopped after inspection.

Automated panel interaction in the real WebKitGTK window is not available in the current environment. AppImage process/API startup can be smoke-tested, while panel lifecycle is covered in Chromium E2E. This limitation prevents claiming a full production-UI smoke PASS.

## 18. Web Inspector / Sysprof availability

- Stable release Tauri configuration does not enable persistent devtools.
- `sysprof` / `sysprof-cli`: not installed.
- `WebKitWebDriver` / `tauri-driver`: not installed.
- Desktop input automation tools: not installed.

No new profiler, WebDriver plugin or system dependency was added. For deeper follow-up, use a separate debug/devtools build or install Sysprof externally, record the Vilra and WebKitWebProcess process family, and correlate the capture clock with manual marker times. Debug timings must not be equated with release timings.

## 19. AppImage build and isolation

The diagnostic AppImage is built with a dedicated `CARGO_TARGET_DIR` under `.run/diagnostics/long-scroll-20261003/`. The stable AppImage is hashed before and after the build and is not overwritten. The Tauri identifier, user app-data path and version remain unchanged.

- Diagnostic AppImage: `.run/diagnostics/long-scroll-20261003/Vilra_0.1.1-diagnostics-long-scroll.AppImage`
- Diagnostic size: `111,589,880` bytes
- Diagnostic SHA-256: `32f9df945b25168fac6d1a44500d9927b28428b9d1840365f8c48f9e3944a313`
- Stable AppImage: `rust/thumb-worker/target/release/bundle/appimage/Vilra_0.1.1_amd64.AppImage`
- Stable SHA-256 before and after: `3973c00ccb8ef6f7a977adb4ad163c57896fbfe36f32a19a8938ed10f0b8aff5`

## 20. User instructions

1. Close the stable Vilra before launching the diagnostic AppImage. Do not run both against one user database.
2. Launch the diagnostic AppImage normally and select/open the usual library.
3. Press `Ctrl+Alt+Shift+L`. If the window manager intercepts it, open Settings, General, Diagnostics, Open.
4. Click `Начать новую запись`.
5. Scroll continuously through thousands of images.
6. Whenever slowdown is visible, click `Сейчас тормозит`. Mark several slow regions and continue until speed recovers.
7. Stop scrolling, leave recording active for a few seconds so current loads can settle, then click `Остановить`.
8. Click `Копировать JSON`. If clipboard access is unavailable, copy the selected JSON from the fallback textarea.
9. Save/send the JSON without editing it. It contains no library paths, image names, IDs or tags.

The panel can be hidden at any time without losing the active or stopped trace.

## 21. Remaining limitations

- A real long user trace has not yet been collected, so the periodic slowdown cause is unknown.
- Resource Timing completeness is conservative/partial because dropped-entry totals are unavailable and the browser buffer can fill.
- Frame intervals identify a main-loop stall proxy, not its CPU/layout/compositor owner.
- PSS, CPU scheduling, I/O wait and physical disk reads are not measured.
- Sparse queue samples can miss short spikes between samples.
- Requests already in flight when recording begins can have incomplete lifecycle timing.
- Full panel/export interaction still needs a manual production WebKitGTK check.

If a marked slowdown shows long frame intervals but normal page/resource/queue metrics, a Sysprof or Web Inspector CPU/rendering capture is the missing measurement. If frontend page time is high while Server-Timing stays low, deeper JS/layout stage instrumentation is needed. If Server-Timing or queue depth spikes, the next investigation belongs in the API/SQLite/worker path. No such conclusion is made before a real trace.

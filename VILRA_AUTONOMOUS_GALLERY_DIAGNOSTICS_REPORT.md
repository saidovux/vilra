# Vilra Autonomous Gallery Diagnostics Report

## 1. Tested HEAD and working tree

- Tested HEAD: `372ea08683f3a74118413fccaafda341848d9fc9`
- Branch: `diagnostics/long-scroll-20261002`
- The Phase 5E implementation is intentionally uncommitted.
- No branch switch, reset, clean, commit, or push was performed.
- User images, tags, production thumbnails, and the production SQLite database were not modified by the investigation. The production database was queried read-only.

## 2. Automatic JSON save implementation

The diagnostic frontend now opens a constrained native session when recording starts. A Tauri command chooses `<app_data_dir>/diagnostics`; the frontend cannot supply a filesystem path. The Rust side validates the report schema and privacy fields, enforces a 4 MiB limit, creates unique session names, and writes through a temporary file followed by sync and rename.

One replaceable checkpoint is kept per session. Periodic checkpoints are delayed briefly while scrolling is active. A final immutable JSON file is reread and parsed before it is accepted. The checkpoint is removed only after final JSON verification. Clipboard export remains an optional fallback and is not required.

After final JSON publication, the local Rust analyzer writes a Markdown report. A Markdown failure does not remove the valid JSON result. The UI displays the diagnostics directory and latest JSON/Markdown paths.

## 3. File locations

- Normal diagnostics directory: Tauri's resolved `<app_data_dir>/diagnostics` (normally `~/.local/share/app.tagimage.desktop/diagnostics` on this Linux environment).
- Isolated diagnostic AppImage: `.run/diagnostics/autonomous-gallery-20261003/Vilra_0.1.1_diagnostics_amd64.AppImage`
- Chromium benchmark artifacts: `.run/diagnostics/autonomous-gallery-20261003/chromium/`
- Isolated native test data: `.run/diagnostics/autonomous-gallery-20261003/native/`
- Native automatic JSON: `.run/diagnostics/autonomous-gallery-20261003/native/data/app.tagimage.desktop/diagnostics/long-scroll-1791049168-877-194138-1.json`
- Native automatic Markdown: `.run/diagnostics/autonomous-gallery-20261003/native/data/app.tagimage.desktop/diagnostics/long-scroll-1791049168-877-194138-1.md`

## 4. Export validation

- [CONFIRMED] Native WebKitGTK stopped the recording automatically and created a 25,138-byte valid schema-1 JSON file.
- [CONFIRMED] The saved session state is `stopped`.
- [CONFIRMED] The analyzer generated a 2,406-byte Markdown file containing all 17 required sections.
- [CONFIRMED] No checkpoint remained after successful final publication.
- [CONFIRMED] The native result contains no `/home/` path, image ID, root path, request URL, filename, or tag field.
- [CONFIRMED] Automatic save worked without clipboard interaction.

## 5. Autonomous tests performed

- Rust workspace tests covered queue recovery and all existing runtime behavior.
- Tauri unit tests covered atomic checkpoint/final writes, JSON integrity, analyzer generation, privacy rejection, report discovery, unique sessions, and non-overwrite behavior.
- Chromium E2E covered automatic native-command save with unavailable clipboard, terminal thumbnail failure diagnostics, independent original loading, long scrolling, pagination, remounting, repeated 202 responses, virtualization, and progressive preview.
- A synthetic 5,040-image metadata source was used for bounded long-scroll and diagnostic-overhead measurements.
- The real user database was inspected only through read-only aggregate queries.

## 6. Real WebKitGTK tests performed

The isolated diagnostic AppImage was run with isolated XDG data/cache/config directories, a temporary SQLite database, and an isolated API port. Its diagnostic recording started automatically, stopped after 10 seconds, and saved both final files. The native API, four thumbnail slots, and metadata worker started successfully and stopped at the end.

This proves native Tauri/WebKitGTK persistence and analyzer execution. It was an empty-library save test, not a native automated long-scroll trace. WebKitGTK long-scroll behavior with the user's real library remains not measured autonomously.

## 7. Black thumbnail investigation

The frontend and backend paths are independent:

1. Gallery tries `GET /thumb-file/:id.jpg`.
2. A missing thumbnail falls back to `GET /thumb/:id`.
3. The fallback may enqueue/dedupe a thumbnail job and return 202.
4. Preview uses `GET /file/:id`, so the original can still open while the gallery thumbnail is absent.

A read-only snapshot of the user database found 44 distinct thumbnail jobs left in `running`. All 44 linked originals inspected in that audit were valid, while all 44 thumbnail files were missing. Their start times spanned multiple old application runs. Because enqueue deduplicates against active `queued`/`running` jobs and claims only `queued` jobs, these rows could return 202 repeatedly without becoming claimable again. This exactly permits a black gallery card with an openable original.

Failed-job history by itself was not a reliable black-card indicator: among 31 distinct failed-job image rows, many already had a valid thumbnail or a permanent source issue. The stale `running` subset was the decisive evidence.

The E2E regression reproduces a terminal thumbnail failure while `/file/:id` returns a valid image. It verifies that the card remains an error placeholder, the original preview reaches `ready`, and diagnostics record the terminal HTTP reason. A `loaded` CSS class is no longer treated as proof of successful decode; natural width and explicit lifecycle events are measured separately.

## 8. Initial scan investigation

- [RELATED] Interruption during initial scanning or thumbnail generation can leave a claimed job in `running` while the indexed original remains active.
- [CONFIRMED] The old runtime had no thumbnail-worker startup call that reclaimed these stale running jobs.
- [CONFIRMED] Reopening the library could therefore preserve the black-card state indefinitely through active-job deduplication.
- [UNKNOWN] The audit cannot prove that every stale row originated specifically during the first scan; process termination during any later generation run has the same result.

No production rescan or thumbnail rebuild was performed.

## 9. Thumbnail worker investigation

The worker starts independent task slots with separate SQLite connections. Each slot can execute synchronous thumbnail work, but the Tokio multithread runtime permits slots to run concurrently. Poll timing can allow one slot to claim repeatedly while others sleep, so uneven attribution is possible without a correctness defect. The reported `thumbs_per_sec` is cumulative since worker start and naturally falls during idle periods.

No evidence established slot imbalance as the cause of black thumbnails or periodic long-scroll slowdown. Worker count, polling interval, decode pipeline, and queue state transitions were not retuned.

The confirmed lifecycle gap was startup recovery. The worker now invokes a job-type-scoped stale recovery once before launching its slots. Only stale `thumb` jobs are considered; metadata and other jobs are untouched. Existing recovery semantics decide whether each current attempt is requeued or terminally failed.

## 10. Long-scroll investigation

The controlled Chromium benchmark alternated diagnostics off/on over six runs. Median results:

| Metric | Diagnostics off | Recording |
| --- | ---: | ---: |
| 120-frame pass | 4,526 ms | 5,012 ms |
| Frame p95 | 99.9 ms | 99.9 ms |
| DOM nodes maximum | under 800 | under 851 |
| Report size median | 0 | 77,924 bytes |
| Diagnostic status requests | 0 | 1 per pass |

Recording duration was about 10.7% higher in this synthetic sequence, while median frame p95 was unchanged. The number of loaded pages/thumbnails also differed between runs, so the duration difference is correlated, not a clean estimate of instrumentation CPU cost. Reports stayed bounded below 96 KiB and the virtualized DOM stayed bounded.

No reproducible monotonic frontend-array slowdown or definitive WebKitGTK compositor/storage bottleneck was established. The instrumentation now preserves the evidence needed for a user-specific native trace instead of assigning a cause from synthetic Chromium timing.

## 11. Confirmed root causes

### Black thumbnails

**CONFIRMED:** stale thumbnail jobs left in `running` prevented both a new deduplicated job and a worker claim. The original route remained independent and usable.

### Periodic long-scroll slowdown

**PARTIAL/UNKNOWN:** missing thumbnails, repeated fallback waits, and queue state can delay visible cards. The current autonomous traces do not prove that they explain every periodic slowdown observed by the user, and Chromium results do not establish WebKitGTK rendering behavior.

## 12. Unconfirmed hypotheses

- [SUSPECTED] A real-library slowdown interval may align with bursts of missing thumbnails or queue growth.
- [SUSPECTED] Poll timing can make per-slot metrics look uneven without reducing total available concurrency.
- [NOT MEASURED] WebKitGTK layout/compositor cost, storage latency, CPU ownership, and a native long-scroll trace over the user's full library.
- [NOT CONFIRMED] Frontend pagination/array work as the primary periodic slowdown source.

## 13. Minimal fixes implemented

1. Added type-scoped stale-job recovery to `tagimage-db` without changing existing generic recovery or queue transitions.
2. Added one thumbnail-worker startup recovery before worker slots begin claiming.
3. Added explicit terminal thumbnail/decode/unavailable diagnostic counters and reason aggregation.
4. Added constrained native checkpoint/final persistence and local Markdown analysis.
5. Added automatic diagnostic-build start/stop mode without changing normal builds.

No gallery loading architecture, retry policy, virtualizer, worker count, database schema, or image processing pipeline was replaced.

## 14. Before/after measurements

Before the fix, the read-only production audit found 44 stale running thumbnail jobs with valid originals and missing thumbnail files. Production data was deliberately not mutated to manufacture an after count.

After the fix, a deterministic worker regression test creates a valid original, claims its thumbnail job, ages the running attempt, runs startup recovery, reclaims the same job, executes it successfully, and verifies the thumbnail file exists. The type-scoped DB test also proves that recovering thumbnail jobs does not requeue a stale metadata job.

The full E2E suite confirms 32/32 scenarios after the change, including a black thumbnail with independently available original and all existing queue/preview/virtualization behavior.

## 15. Remaining limitations

- No user-specific native long-scroll JSON was collected; the native report validates persistence with an empty isolated catalog.
- The startup recovery only runs when the updated thumbnail worker starts. Existing production stale rows are intentionally untouched by this investigation until the user runs the updated build normally.
- A sudden crash can leave the latest checkpoint rather than a final report, by design.
- Cross-process CPU, disk I/O, and WebKit compositor timing are not measured.
- The expected stable AppImage path contained no AppImage before this phase, so there was no stable file to hash comparatively. The diagnostic bundle was built in an isolated target and copied under a diagnostic filename.

## 16. Instructions for obtaining user-specific diagnostics

1. Close any other Vilra instance so two applications do not share the same runtime database.
2. Run `.run/diagnostics/autonomous-gallery-20261003/Vilra_0.1.1_diagnostics_amd64.AppImage`.
3. Scroll the real gallery normally, including the intervals where loading slows or cards remain black.
4. The diagnostic build starts recording automatically and saves automatically after 10 minutes. The panel also allows earlier manual stop; stopping does not require copying JSON.
5. The panel displays the exact JSON and Markdown paths. On this Linux setup they are normally under `~/.local/share/app.tagimage.desktop/diagnostics/`.

The diagnostic report contains aggregate timing and state only. It excludes image IDs, paths, filenames, tags, request URLs, and SQLite rows.

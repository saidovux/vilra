# Vilra Gallery Loading Report

## 1. Tested HEAD and original working tree

- Branch: `main`
- Starting HEAD: `c4723c9566b38b606e7f7401f226713f68efaf98`
- Starting working tree: clean
- Production target: Tauri AppImage on Linux with WebKitGTK
- Benchmark comparison: three fixed-step runs per candidate in Playwright Chromium
- Raw artifacts: `.run/benchmarks/gallery-loading-20261001T180311Z/`

The source fixes were tested against the starting commit without changing user images or the normal runtime database. The application version was subsequently raised from `0.1.0` to `0.1.1` because the AppImage in the historical standard target directory was an older build.

## 2. Test isolation and production safety

The previous E2E harness shared `.run` PID files with a normal Vilra instance. This could make teardown stop a user's running application. The harness now sets dedicated `TAGIMAGE_RUN_DIR` and `TAGIMAGE_LOG_DIR` values and retains its existing isolated SQLite database and fixture image tree.

- E2E runtime: `.run/e2e-runtime/`
- E2E logs: `.run/e2e-logs/`
- E2E SQLite: `.run/e2e/tagimage.sqlite`
- E2E images: `.run/e2e-images/`
- Benchmark data: `.run/benchmarks/gallery-loading-20261001T180311Z/`

Teardown stops only the isolated E2E process group. Production originals, tags, jobs, SQLite data, and runtime PID files were not modified.

## 3. Existing architecture

The retained gallery path is:

1. Cursor-paginated `/api/images` responses, 48 records per page.
2. TanStack Virtual masonry with an overscan of 20 virtual items.
3. Native eager `<img>` elements only for the mounted virtual range.
4. Primary `/thumb-file/:id.jpg?v=<source-mtime>` request.
5. `/thumb/:id?v=<source-mtime>` fallback for generation and `202` retry handling.
6. Browser-managed decoded and HTTP resources after cards unmount.

Pagination is prefetched when the virtual range enters a threshold of `max(48, lanes * 8)` from the currently loaded end. Card retry timers and fallback object URLs are released on unmount. The thumbnail worker and SQLite job flow were not changed in this phase.

## 4. Confirmed bottlenecks

Four concrete defects were found:

- Missing thumbnail responses had no explicit negative-cache policy.
- A one-year immutable policy was unsafe because the URL version represented source mtime, not rebuilt thumbnail content.
- A cursor request started for an old filter/sort generation could append after a full refresh.
- The gallery image opacity transition added up to 200 ms after the image `load` event.

Normal-scroll prefetch was already effective in the controlled benchmark. A new scheduling subsystem was therefore not justified.

## 5. HTTP negative-cache investigation

The old `/thumb-file/:id.jpg` missing-file path returned `404` without `Cache-Control`. This was a confirmed response-policy defect because temporary absence is expected while a thumbnail job is pending, and user-agent negative caching could preserve that temporary state.

The route now returns `Cache-Control: no-store` for temporary `404` responses. Terminal image-unavailable `422` responses also use `no-store`. An E2E test verifies a `404` primary request, repeated `202` fallback responses, successful generation, and a later primary `200`.

Browser-specific stale-negative-cache behavior was not directly reproduced in WebKitGTK.

## 6. Thumbnail versioning investigation

The primary URL includes source mtime, while the old response used `public, max-age=31536000, immutable`. Rebuilding a thumbnail without changing the original left the URL unchanged, so immutable caching could retain obsolete thumbnail bytes.

Successful thumbnail responses now use:

- `Cache-Control: public, max-age=0, must-revalidate`
- A content-derived `ETag`
- `304 Not Modified` for a matching `If-None-Match`
- A new `ETag` and `200` when thumbnail content changes

This keeps the stable URL, avoids random cache busting, saves response-body transfer on successful revalidation, and makes forced rebuilds observable even when source mtime is unchanged.

## 7. Pagination race investigation

The old `activePageLoad` tracked only a promise. A sort/filter refresh could replace gallery state while an earlier cursor page remained in flight, after which the stale response could append old rows.

Page loads now capture the current image request generation and cursor. Stale responses are discarded, and an old request's `finally` block cannot clear or reschedule the active generation. A deterministic E2E test holds an old cursor response, changes sorting, releases the old response, and verifies that no stale IDs enter the gallery.

## 8. CSS presentation latency

`.card img` previously used `transition: opacity .2s`. The `loaded` class was applied at the image `load` event, but full visual opacity was delayed by another 200 ms. The transition was removed. The image now becomes visible on the next paint after `load`.

This is a deterministic removal of up to 200 ms of application-controlled presentation delay. It is not presented as a direct WebKitGTK timing measurement.

## 9. Baseline benchmarks

The reproducible runner is `.run/benchmarks/gallery-loading-20261001T180311Z/gallery_bench.mjs`. It uses 5,040 metadata records, controlled response delays, and realistic JPEG/WebP payloads in landscape, portrait, and square aspect ratios. Baseline bundles were built from the tested HEAD; final bundles were built from the changed source.

The principal comparison is the median of three identical fixed-step runs at a 1365x768 Chromium viewport. The runner intercepts thumbnail traffic, so browser HTTP-cache behavior is intentionally excluded from these presentation/scheduling values. Cache semantics are tested separately against the real Rust handler.

Baseline medians:

| Scenario | Visible before entry | Unloaded p95 | Thumbnail requests | Bytes | Max thumb concurrency | Frame interval p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Normal scroll | 100% | none observed | 215 | 5,696,462 | 40 | 66.7 ms |
| Fast scroll | 59.494% | 277.05 ms | 110 | 2,929,967 | 45 | 50.0 ms |

The deep-scroll diagnostic reached all 5,040 records but did not keep identical depth per unit time across candidates. It is retained as raw diagnostic evidence, not used as the primary before/after claim.

## 10. Solutions considered

The following options were evaluated:

- Keep existing TanStack overscan and fix correctness/cache defects.
- Add a direction-aware bounded thumbnail scheduler with concurrency 32.
- Add the same scheduler with concurrency 48.
- Increase page size or overscan.
- Add a custom in-memory image cache.

Both scheduler candidates produced mixed or regressed throughput/tail results and added lifecycle complexity. They were reverted. Page size, overscan, decoded-image caching, worker count, and thumbnail quality were left unchanged because the baseline did not establish a need.

## 11. Changes implemented

- Isolated E2E PID and log state from the normal runtime.
- Added generation-safe cursor pagination.
- Removed the gallery image opacity transition.
- Added explicit non-cacheable temporary `404` and terminal `422` responses.
- Replaced unsafe immutable thumbnail caching with content ETag revalidation.
- Added E2E coverage for temporary thumbnail absence, retry cleanup, direction reversal, and stale pagination.
- Added Rust coverage for `404`, `304`, and changed-content `200` cache behavior.

No custom prefetch queue, RAM cache, worker change, schema change, or original-image preload was added.

## 12. Prefetch strategy

The existing strategy is retained:

- TanStack Virtual overscan: 20 items.
- Metadata page: 48 rows.
- Metadata prefetch threshold: at least one page.
- Visible cards receive high fetch priority when mounted; overscan cards use automatic priority.
- Thumbnail lifecycle remains bounded by mounted virtual cards.

Normal scrolling already produced 100% loaded-before-visible results in all fixed runs. A direction-aware scheduler was tested and reverted because it did not demonstrate a consistent net benefit.

## 13. Cache strategy

- Ready thumbnails: normal browser cache with mandatory ETag revalidation.
- Unchanged thumbnail: `304`, no response body.
- Rebuilt thumbnail at the same URL: changed ETag and fresh `200` body.
- Missing thumbnail: `404 no-store`, allowing later recovery.
- Terminal unavailable source: `422 no-store`.
- Fallback generation requests: frontend `fetch(..., {cache: 'no-store'})`.
- Fallback Blob URLs: revoked on load, error, stale completion, or unmount.

There is no new application-level decoded-image cache and no unbounded retained resource set.

## 14. Thumbnail worker behavior

The thumbnail worker, queue state machine, retry policy, worker count, file publication, and SQLite write behavior are unchanged. The backend delivery handler is the only Rust production path changed. Missing thumbnails still use the existing fallback endpoint to enqueue or wait for normal worker generation.

## 15. Memory behavior

The fixed benchmark retained approximately 65-70 mounted cards and 620-650 DOM nodes while traversing a 5,040-image logical gallery. The DOM remained bounded below the E2E limit of 4,000 nodes.

No scheduler queue or image-byte cache was retained. Retry timers remain keyed by mounted image ID and are cleared during unmount. Production WebKitGTK process-family PSS was not safely measurable in this phase and is marked `NOT MEASURED`.

## 16. Before/after comparison

Values are medians of three normalized fixed-step Chromium runs unless stated otherwise.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Normal loaded before visible | 100% | 100% | retained |
| Fast loaded before visible | 59.494% | 76.744% | +17.25 pp, variable Chromium result |
| Fast unloaded-image latency p95 | 277.05 ms | 139.50 ms | -49.6%, variable Chromium result |
| Normal thumbnail requests | 215 | 225 | +10 due to reached-card variance |
| Fast thumbnail requests | 110 | 110 | unchanged |
| Normal transferred bytes | 5,696,462 | 5,954,628 | +4.5% due to reached-card variance |
| Fast transferred bytes | 2,929,967 | 2,929,967 | unchanged |
| Duplicate thumbnail requests | 0 | 0 | unchanged |
| Normal max thumb concurrency | 40 | 40 | unchanged |
| Fast max thumb concurrency | 45 | 40 | -5 |
| Normal frame interval p95 | 66.7 ms | 49.9 ms | improved in Chromium sample |
| Fast frame interval p95 | 50.0 ms | 50.0 ms | unchanged |
| Mounted cards | 70 | 65-70 | bounded |
| DOM nodes | 650 | 620-650 | bounded |
| Pending custom scheduler tasks | 0 | 0 | unchanged |
| Process-family PSS | NOT MEASURED | NOT MEASURED | NOT MEASURED |

The code changes do not introduce a scheduler that could directly explain all fast-scroll variation, so the numeric fast-scroll improvement is supporting evidence rather than a guaranteed production gain. The pagination, HTTP policy, ETag behavior, and CSS delay fixes have deterministic tests or direct code-level proof.

## 17. WebKitGTK results and limitations

Direct production WebKitGTK gallery timing, cache, and PSS measurements are `NOT MEASURED`. The available environment did not provide a safe existing WebKit automation route, and a new automation subsystem was outside this phase.

The AppImage build verifies production compilation and packaging. Playwright Chromium verifies functionality and controlled comparative behavior, but its numbers are not presented as WebKitGTK measurements.

Manual WebKitGTK verification should cover normal downward scroll, rapid reversal, revisiting cards, a thumbnail appearing after temporary absence, and a forced thumbnail rebuild.

## 18. Regression tests

Passed before the packaging-only `0.1.1` version update:

- `cargo fmt --all --manifest-path rust/Cargo.toml -- --check`
- `cargo check --manifest-path rust/Cargo.toml --workspace`
- `cargo test --manifest-path rust/Cargo.toml --workspace`
- `npm run typecheck`
- `npm run build:frontend`
- `npm run test:e2e`: 25 passed
- Tauri `cargo fmt --check`
- Tauri `cargo check`
- Tauri `cargo test`: 2 passed
- AppImage `0.1.1` build with the established isolated Cargo target
- Isolated AppImage smoke: `db_ready=true`, `ready=true`, one fixture indexed, all processes stopped

The complete E2E suite includes the 5,040-image virtual gallery, deep/reverse scroll, resize, stable IDs, cursor pagination, live filesystem behavior, preview behavior, thumbnail retry, and terminal `422` handling. The E2E runtime was stopped by its isolated teardown.

Published AppImage:

- Path: `rust/thumb-worker/target/release/bundle/appimage/Vilra_0.1.1_amd64.AppImage`
- Size: 111,548,920 bytes
- SHA-256: `3973c00ccb8ef6f7a977adb4ad163c57896fbfe36f32a19a8938ed10f0b8aff5`
- Standard AppImage directory contents: this file only

## 19. Remaining limitations

- WebKitGTK timings and process PSS require manual target-runtime measurement.
- Content ETag generation reads the thumbnail bytes before responding; this trades a small local read/hash cost for correct rebuild invalidation and `304` body savings.
- The benchmark's intercepted thumbnail requests deliberately do not measure real browser HTTP-cache hit rates.
- Deep-scroll request totals varied with achieved depth and timing, so they are not used to claim a transfer reduction.
- The historical default Cargo target contains stale absolute paths from an older checkout; AppImage packaging uses an isolated target and publishes the final artifact into the standard AppImage directory.

## 20. Decision

**PROVISIONAL**

Keep the minimal correctness, cache, presentation, and test-isolation fixes. They pass Rust and Chromium regression gates without adding an unbounded queue or cache. Do not keep the experimental custom scheduler. Final production-performance acceptance remains provisional until the gallery is manually checked in WebKitGTK.

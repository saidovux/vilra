# Vilra Round 3B1: Scroll-Aware Missing-Thumbnail Admission

Starting HEAD: `5a7de9759e1a500564bd32c3c968cc841d857e7f`

Changed files:

- `static/src/main.ts`
- `rust/api-server/src/handlers.rs`
- `e2e/thumbnail-admission.spec.ts`
- `e2e/gallery-sqlite.spec.ts`
- `e2e/gallery-diagnostics.spec.ts`
- `e2e/gallery-virtualization.spec.ts`
- `VILRA_ROUND_03B1_REPORT.md`

## Implementation

- Admission scheduler: a primary `/thumb-file/:id.jpg` miss now registers a mounted lifecycle. The scheduler admits current viewport misses first and only admits a small directional near window after visible work is resolved. Cached thumbnails still use the unchanged direct path.
- Velocity smoothing/hysteresis: TanStack `scrollOffset`, `scrollDirection`, timestamps, an EMA, two confirming samples, `THUMB_FAST_ENTER_THRESHOLD=1.25`, and `THUMB_FAST_EXIT_THRESHOLD=0.55` drive fast-scroll state. `sync=false` settles immediately; a one-shot 180 ms fallback covers engines that omit the final callback.
- Visible/near priority: frontend sends only `class=visible|near`. Server priorities are named and ordered `VISIBLE=50 > NEAR=40 > LEGACY=30 > BACKGROUND=10`. A request without `class` remains priority 30; arbitrary classes return HTTP 400. Existing SQLite dedupe promotes queued jobs.
- 202 lifecycle: `/thumb` is called once. A 202 switches the lifecycle to bounded `/thumb-file` polling with 300 ms initial delay, 1.5x backoff, 2 s maximum interval, 30 attempts, and 45 s maximum lifetime.
- Cancellation: every mounted lifecycle owns one timer and one `AbortController`. Unmount, card generation/version replacement, terminal response, and image removal cancel stale work and revoke object URLs. `AbortError` is non-terminal.
- Pagination change: **NO**. The existing code passed the new slow cursor completion/liveness regression test.

## Tests

- Rust handler tests cover legacy, near, visible, invalid class, active dedupe, and queued priority promotion.
- New frontend E2E covers visible-before-near admission, one 202 admission, cache-only polling, one poll loop, fast-scroll suppression, settle admission, and transient-card suppression.
- Existing thumbnail lifecycle tests now assert one admission followed by `/thumb-file` polling.
- Unmount regression verifies an in-flight cache poll is aborted without another `/thumb` request.
- Pagination regression verifies that a completed slow cursor page with `has_more=true` can trigger the following page.
- Fast-scroll E2E was also repeated three times successfully.

## Verification

- `npm run typecheck`: passed.
- `npm run build:frontend`: passed.
- `npm run test:e2e`: passed, 36/36. An earlier full run hit the pre-existing diagnostics test's 120 s timeout; that test passed alone unchanged, and the complete rerun passed in 3.0 minutes.
- `cargo fmt --all -- --check`: passed.
- `cargo check --workspace`: passed.
- `cargo test --workspace`: passed: API 28, metadata 6, thumb-worker 18, core 7, DB 51, doc tests 0 failures.
- Tauri dev compilation and native launch: passed. No AppImage was built.
- Final SQLite integrity check on the isolated missing-thumbnail copy: `ok`.
- All API, Tauri, and worker processes were stopped.

## Native Verification

Ready path:

- Isolated Round 2 library: 8,866 active DB rows, zero missing thumbnail files.
- Five-second native WebKitGTK wheel run remained `ready=true`, queue depth/running/stale all zero, and generated no jobs.

Moderate scroll:

- Isolated Round 3A library: 8,866 active DB rows, 3,298 thumbnail files initially missing.
- Five-second native scroll admitted 11 near jobs, queue peak 3; all 11 succeeded, zero failed, zero active afterward.

Fast scroll:

- Four concurrent native wheel drivers produced approximately 160 wheel events over five seconds.
- Only 5 jobs were admitted during the fast interval; queue peak was 4 and zero jobs failed.

After stop:

- Settle admitted 5 additional current-viewport jobs at priority 50.
- The remaining in-flight plus settled work drained successfully; final queue/running/stale counts were all zero and `ready=true`.
- Visible work was priority 50; moderate directional lookahead was priority 40.

## Before -> After

- `/thumb` admissions: Round 3A observed 178 fallback attempts in its 121-second diagnostic window; focused E2E now records exactly 1 admission per mounted lifecycle. Short native runs admitted 11 moderate, 5 fast, and 5 after stop.
- Queue peak: Round 3A peak 83; short native Round 3B1 peak 3 moderate and 4 fast. Durations differ, so this is a smoke comparison, not a replacement ten-minute benchmark.
- Generated thumbnails: Round 3A generated 202 over the long run; short Round 3B1 native verification completed 11 moderate jobs and 10 fast/settle jobs.
- Repeated `/thumb` after 202: present in the old retry flow; now zero in focused E2E.
- `/thumb-file` polls: old flow did not separate cache polling; focused lifecycle used two cache polls after its single 202 admission and never ran concurrent poll loops.
- Visible thumbnail latency: not claimed from the short native smoke.
- `/api/images` latency: not measured in this short round.

## Regressions

- No ready-thumbnail queue regression in native smoke.
- No failed or stale thumbnail jobs.
- No SQLite schema, worker-count, overscan, virtualizer, preview, or decoder changes.
- Pagination remains independent from thumbnail readiness.

## Verdict

**KEEP**

All acceptance conditions passed in focused tests and short isolated native verification. Fast scrolling admits substantially less work, settle promotes current viewport work, 202 no longer re-enters `/thumb`, and lifecycle cleanup is bounded.

Remaining bottleneck: admitted current-viewport jobs still pay the existing decode/render/filesystem cost, and priority cannot preempt jobs already running.

Next recommended step: **none**. Gather normal-use feedback before changing worker concurrency, grace wait, decoder, or adding background generation.

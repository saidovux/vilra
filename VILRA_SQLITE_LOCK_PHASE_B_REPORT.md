# Vilra SQLite Lock Phase B Report

## Scope And Starting State

- Branch: `main`.
- Starting HEAD: `c3aebde4190979fc2192a30360ec386369e7a7b7`.
- Starting worktree: clean.
- Timeout policy remains unchanged: runtime/API `5,000 ms`, thumb/metadata workers `30,000 ms`.
- No manual retry loops, transaction-body replay, startup sleeps, worker-count changes, schema changes, or SQLite index changes were added.

## Thumbnail Temp Lifecycle

The pre-publish leak was reproduced before the fix with the new deterministic test. A second connection held `BEGIN IMMEDIATE`, finalization returned `DatabaseBusy`, the publisher was not called, and the attempt-specific temp thumbnail remained on disk.

The failure branch now always best-effort removes only the unique attempt temp path when `finalize_sqlite_thumb_success()` returns `Err`. It then preserves the original DB error, except for the existing publisher-error path that intentionally records a retryable job failure. Generic cleanup never targets the final thumbnail path.

Results:

- pre-publish DB failure: temp removed, final absent, publisher not called, job not succeeded, no succeeded event;
- post-publish injected DB failure: temp absent, final thumbnail survives, transaction rolls back, job is not marked succeeded, no succeeded event;
- hard-crash orphan sweeping was not added because ownership of an active attempt cannot be proven by a broad filename scan.

## Worker Diagnostics

Fatal errors returned after a successful claim now retain the original error and add stable execution identity:

- thumb: `worker`, `slot`, `job`, and `attempt`;
- metadata: `worker`, `job`, and `attempt`.

Expected `Succeeded`, `Failed`, and `Discarded` execution values are unchanged. Focused tests verify the context fields and an underlying sentinel error without asserting brittle full strings.

## Worker Connection Contention

`forced_writer_contention_waits_then_claims_once` now opens the competing connection directly through production `open_sqlite_worker_db()` and verifies `PRAGMA busy_timeout = 30000`. A held writer lock is released after 75 ms; the production worker connection then claims exactly once with attempt `1`, one `job_attempt`, one `started` event, and the expected worker ID.

Existing tests still verify:

- runtime open: `PRAGMA busy_timeout = 5000`;
- worker open: `PRAGMA busy_timeout = 30000`;
- exhausted short test timeout returns typed `DatabaseBusy` with bounded wait;
- `DatabaseLocked` remains distinct from `DatabaseBusy`.

## API Write Stress

The stress used a fresh isolated database and 240 generated PNG fixtures under `.run/sqlite-lock-phase-b/`. It ran four thumb slots, one metadata worker, real thumb jobs, and 240 metadata jobs enqueued through `enqueue_sqlite_metadata_job()`.

The first measured run exposed one real API issue: 69/70 writes succeeded, while one `PATCH /api/session` exhausted the 5-second runtime budget after 5,056.684 ms. The error occurred on the redundant `INSERT INTO app_session ... ON CONFLICT DO NOTHING` that preceded a separate `UPDATE`. Timeout constants were not changed. The two write statements were replaced by one atomic session UPSERT, reducing normal session persistence to one writer-lock acquisition.

Final measured run after that focused fix:

| Operation | Requests | Success | DatabaseBusy | Other errors | Median ms | p95 ms | Max ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `POST /api/tags` | 15 | 15 | 0 | 0 | 215.400 | 3661.772 | 3661.772 |
| `PATCH /api/tags/:tag` | 15 | 15 | 0 | 0 | 190.326 | 3532.763 | 3532.763 |
| `POST /api/tag/:img_id` | 15 | 15 | 0 | 0 | 145.671 | 223.926 | 223.926 |
| `PATCH /api/session` | 15 | 15 | 0 | 0 | 145.156 | 234.754 | 234.754 |
| `POST /api/thumbs/rebuild` | 10 | 10 | 0 | 0 | 48.683 | 602.030 | 602.030 |
| **Total** | **70** | **70** | **0** | **0** | | | **3661.772** |

All renamed tags were persisted, image-tag responses contained the requested user tags, and the final session values matched the last successful write. Here, zero returned `DatabaseBusy` means no operation exhausted its busy budget; it does not mean SQLite experienced no internal lock waiting.

## Mixed Worker Stress

Final queue state:

| Type | Jobs | Succeeded | Failed | Queued | Running | Attempts | Enqueued events | Started events | Succeeded events |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| thumb | 250 | 250 | 0 | 0 | 0 | 250 | 250 | 250 | 250 |
| metadata | 240 | 240 | 0 | 0 | 0 | 240 | 240 | 240 | 240 |

The thumb count consists of 240 startup jobs plus 10 non-deduped rebuild jobs. Metadata samples had succeeded jobs and persisted nonzero dimensions, mtimes, and image IDs.

Additional invariants:

- duplicate `(job_id, attempt)` rows: 0;
- duplicate terminal events for the same job/state: 0;
- stale-running jobs: 0;
- stale recovery events: 0;
- fatal worker exits: 0;
- exhausted `DatabaseBusy` entries in final API/worker logs: 0;
- handled-execution orphan attempt temp files in the isolated fixture: 0.

## Observed Facts And Inference

Observed in Phase B: the first mixed write run exhausted the API's 5-second budget on the redundant session ensure-write while worker queues were active. After replacing the two-statement session save with one UPSERT, the fresh equivalent run completed all 70 writes and drained both queues.

Observed previously: the original worker failure occurred at `BEGIN IMMEDIATE` and returned `DatabaseBusy` after exhausting its then-current budget. No lock-owner instrumentation identified one definitive owner. Overlapping indexer/API/worker writes remain a reasonable explanation, not a proven identity for the original lock holder.

## Validation

- focused `tagimage-db`: 45/45 passed;
- focused thumb worker: 14/14 passed, including pre-publish cleanup and post-publish safety;
- focused metadata worker: 6/6 passed;
- `cargo fmt --all -- --check`: passed;
- `cargo check --workspace`: passed;
- `cargo test --workspace`: passed, 96 tests total;
- `npm run typecheck`: passed;
- `npm run build:frontend`: passed;
- `npm run test:e2e`: passed, 22/22;
- repeated clean live-filesystem startup test: 5/5 passed;
- repeated-start logs: no worker crash, exhausted `DatabaseBusy`, panic, or live-thumbnail timeout;
- `git diff --check`: passed before report creation and rerun in the final gate.

## Files Changed

- `rust/thumb-worker/src/main.rs`
- `rust/metadata-worker/src/main.rs`
- `rust/crates/tagimage-db/src/sqlite.rs`
- `rust/crates/tagimage-db/src/sqlite_runtime.rs`
- `VILRA_SQLITE_LOCK_PHASE_B_REPORT.md`

## Decision

**KEEP.** The confirmed temp leak is closed without touching final thumbnails, post-publish rollback behavior is covered, fatal worker diagnostics retain full execution identity, production worker contention behavior is tested, representative HTTP writes pass under real mixed worker pressure, both queues drain without duplicate/stale state, and all validation gates pass. Timeout values remain unchanged.

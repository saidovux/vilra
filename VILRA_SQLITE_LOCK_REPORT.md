# Vilra SQLite Lock Reliability Report

## Scope And Starting State

- Branch: `main`.
- Starting HEAD: `ccacdf11f319e1acee726eafa47784f6a2e4bc22`.
- The worktree was clean before this task.
- SQLite Phase A remains intact: no-tag pages still omit the redundant `GROUP BY`, and no-tag totals still use `count_sqlite_images()`.
- No schema, index, PRAGMA journal mode, frontend, sidecar supervision, or job-state transition was changed.

## Failure Identification

The prior real E2E failure occurred while a worker called `claim_next_sqlite_job()`. Its `with_immediate_tx()` failed at `BEGIN IMMEDIATE`, after which `?` propagated the error out of the worker loop and terminated the process. In packaged Tauri, `watch_runtime()` would then exit the application because a managed sidecar exited unexpectedly.

A clean single-test baseline run did not reproduce the nondeterministic crash. The equivalent contention was therefore reproduced deterministically:

1. connection A acquired `BEGIN IMMEDIATE` and held the writer lock;
2. connection B attempted the real `claim_next_sqlite_job()` path;
3. before A released the lock, the job remained queued with attempt `0`, no `job_attempt`, and no `started` event;
4. after release, B claimed exactly once and wrote one attempt and one started event.

A separate short-timeout acquisition test retained the typed `rusqlite::Error` and identified:

- primary error: `ErrorCode::DatabaseBusy` / `SQLITE_BUSY`;
- extended code: `5` (`SQLITE_BUSY`);
- exact operation: `BEGIN IMMEDIATE` before the transaction body;
- bounded test wait: at least 30 ms and below 500 ms with a configured 40 ms timeout.

A diagnostic copy of the stress DB was locked for 6 seconds. The previous 5,000 ms policy returned `database is locked` after **5.02 seconds**, confirming that SQLite's existing busy handler was active and exhausted its configured budget. No string parsing is used for classification.

`DatabaseLocked` / `SQLITE_LOCKED` is tested separately and is not classified as `DatabaseBusy`.

## Root Cause And Transaction Audit

WAL allows concurrent readers but still serializes writers. During the actual `start.sh` path the API becomes reachable first, workers start, and then `set_folder` starts LiveIndexer reconciliation. Reconciliation performs a sustained sequence of short image/tag/job writes while thumbnail slots and metadata worker also attempt queue transactions. A waiting writer can exhaust the 5-second budget under that sustained contention even though no single startup transaction owns the lock for five seconds.

The immediate-transaction bodies were audited. Startup reconciliation does not wrap the full scan, filesystem traversal, image inspection, decode, encoding, sleep, or polling in one writer transaction. Queue claims only update the job, insert one attempt, insert one event, and commit. The thumbnail finalize transaction contains only the guarded same-filesystem publish/rename plus final DB state; moving that publish outside the attempt guard would weaken stale/canceled-attempt safety, so it was left unchanged. Bulk path rename/hide and stale recovery can loop inside transactions, but they are not used by normal startup reconciliation and were not the observed owner.

No accidentally long startup transaction was found. The practical root cause is legitimate background writer pressure plus a worker wait budget sized like an interactive connection.

## Startup Sequences

`start.sh`:

```text
initialize DB -> start API -> wait for API -> start thumb worker
-> start metadata worker -> set folder -> reconciliation and queue consumption overlap
```

Packaged Tauri:

```text
initialize DB -> spawn API/thumb/metadata sidecars -> wait for API readiness
-> supervise every sidecar with watch_runtime()
```

Packaged runtime keeps four thumbnail slots. Supervision was not disabled or weakened.

## Fix

Previous policy:

- API, LiveIndexer, thumbnail workers, and metadata worker: SQLite `busy_timeout = 5,000 ms`.

New policy:

- API and other interactive/runtime connections: unchanged at **5,000 ms**;
- thumbnail and metadata worker connections: **30,000 ms** through `open_sqlite_worker_db()`.

Both policies use rusqlite/SQLite's existing busy handler. There is **no manual retry loop**, no second retry layer, no backoff multiplication, and no transaction closure replay. The maximum lock-acquisition wait is 5 seconds for interactive runtime connections and 30 seconds for worker connections. If that worker budget is exhausted, the typed code, extended code, wait duration, source call site, worker ID, and slot are included in the fatal context; genuine failures still propagate.

The two duplicate `with_immediate_tx()` implementations were consolidated without changing body/commit/rollback semantics. Typed `rusqlite::Error` information is retained until after the acquisition error is classified and formatted.

## Deterministic Tests

- `forced_writer_contention_waits_then_claims_once`: passed. The body did not execute while locked; after release there was one claim, attempt `1`, one `job_attempt`, one `started` event, and the expected worker ID.
- `immediate_transaction_timeout_preserves_busy_code_and_bound`: passed with `DatabaseBusy`, extended code `5`, and bounded wait.
- `database_locked_is_not_classified_as_database_busy`: passed.
- Existing `concurrent_claims_never_return_duplicate_jobs`: passed.
- Worker/runtime connection test confirms API timeout remains 5,000 ms and worker timeout is 30,000 ms.

## Runtime Stress

### Two thumbnail slots

- Full E2E: **22/22 passed**, including the previously failing live-filesystem thumbnail test.
- Five additional clean fresh-start runs of that scenario: **5/5 passed**.
- Durations: 26, 27, 28, 29, and 34 seconds. The pre-fix baseline single run was 35.74 seconds, so no startup regression was measured.
- Worker `DatabaseBusy`/locked exits: **0**.
- Fatal worker exits: **0**.

Some targeted runs stopped with queued/running jobs because Playwright teardown intentionally stops the app as soon as the scenario completes. This was not a worker crash; the copied logs contain no fatal or lock error.

### Four thumbnail slots

A fresh DB and 240 generated images under `.run/sqlite-lock-stress/` exercised the packaged worker count:

- images indexed: 240/240;
- indexing span from first to last image insert: 47.249 seconds;
- first enqueue to final job completion: 61.318 seconds;
- thumb jobs: 240 succeeded, 0 queued, 0 running, 0 failed;
- attempts: 240;
- events: 240 enqueued, 240 started, 240 succeeded;
- `DatabaseBusy`/locked log entries: 0;
- fatal worker exits: 0;
- API, thumbnail worker, and metadata worker were all alive after queue drain.

The current normal indexer did not enqueue metadata jobs in this fixture, so metadata completion count was 0; metadata worker survival was verified. No value is inferred for an unexercised metadata workload.

## Performance Guardrail

The API keeps its existing 5-second policy. During active four-slot reconciliation/queue pressure, 15 representative no-tag `/api/images` requests measured:

- median: 41.024 ms;
- p95 sample: 62.780 ms;
- max: 63.335 ms.

After queue drain, 30 requests measured:

- median: 30.306 ms;
- p95: 47.703 ms;
- max: 53.557 ms.

No request approached either timeout, and the worker-specific timeout does not apply to API connections. Phase A query correctness tests and the full Rust workspace remain green.

## Validation

- `cargo fmt --all -- --check`: passed.
- `cargo check --workspace`: passed without warnings.
- `cargo test --workspace`: passed, 92 tests.
- `npm run typecheck`: passed.
- `npm run build:frontend`: passed.
- `npm run test:e2e`: passed, 22/22.
- Five repeated clean-start targeted E2E runs: passed, 5/5.
- Four-slot/240-image startup stress: passed and fully drained.
- Tauri cargo check: passed with isolated `CARGO_TARGET_DIR`; the default cache first failed because it still referenced the old `/TagImage` path.
- `git diff --check`: passed before report creation and is rerun in the final gate.

## Rejected Approaches

- No custom `BEGIN IMMEDIATE` retry: SQLite's busy handler already performs bounded waiting.
- No global 30-second timeout: interactive API behavior stays bounded at 5 seconds.
- No startup sleeps or delayed folder selection.
- No reduction from four packaged thumbnail slots.
- No swallowed worker errors or disabled Tauri supervision.
- No replay of transaction bodies, commits, or filesystem side effects.

## Files Changed

- `rust/crates/tagimage-db/src/sqlite.rs`
- `rust/crates/tagimage-db/src/sqlite_runtime.rs`
- `rust/thumb-worker/src/main.rs`
- `rust/metadata-worker/src/main.rs`
- `VILRA_SQLITE_LOCK_REPORT.md`

## Decision

**KEEP.** The real failure location and SQLite category are identified, the existing busy handler is understood, the fix is worker-scoped and bounded, transaction bodies are not replayed, duplicate claim/attempt/event invariants hold, full and repeated E2E runs pass, four-slot startup drains cleanly, and the API retains its interactive latency policy.

# Vilra SQLite Phase C Report

## Starting state

- Branch: `main`
- Starting HEAD: `1794f031c2d8dddee3d51e532bd6fb5ab1a63567`
- Runtime/API busy timeout: `5,000 ms` before and after
- Worker busy timeout: `30,000 ms` before and after
- No manual transaction retry loop, timeout increase, global DB mutex, schema change, commit, or push was added.

Changed areas:

- atomic session mutation in `tagimage-db`;
- API session handling and narrow blocking-task isolation for measured write routes;
- deterministic DB concurrency tests;
- isolated real-process SQLite stress harness and helper;
- this report.

## Session atomicity

The old session path read the complete session before owning SQLite's writer lock and later wrote the complete stale snapshot. Concurrent updates to unrelated fields, and concurrent root appends, could therefore overwrite each other.

The new shared mutation primitive performs:

```text
BEGIN IMMEDIATE
load current session
capture BEFORE
apply mutation
persist once
load AFTER
COMMIT
return BEFORE + AFTER
```

`save_sqlite_session_value()`, `set_sqlite_session_root()`, and the combined API root/field mutation use this primitive. Helpers called inside it do not open nested transactions.

Filesystem canonicalization and directory validation happen before `BEGIN IMMEDIATE`.

## Concurrent session tests

Deterministic tests use separate SQLite connections and synchronization channels:

- different fields preserve both updates;
- same-field writes serialize and last commit wins;
- concurrent root appends preserve both roots without duplicates;
- all session fields and null behavior remain compatible;
- canonical root values take precedence over payload `root_path`/`root_paths`;
- root plus normal fields is persisted atomically;
- root changes reset `last_image_id`, while an explicitly supplied value retains existing API precedence.

Real HTTP stress performed five rounds of two concurrent PATCH requests. Final candidate: `5/5` correct rounds in each of three runs, with all `15/15` reset/PATCH requests successful per run.

## BEFORE/AFTER side effects

The API no longer compares the committed result with a session loaded before the transaction. `folder_tag_sync` change detection uses transaction-local `before` and `after` states returned by the same serialized mutation.

EventHub publication, LiveIndexer root changes, and reconciliation requests occur only after the SQLite transaction commits. This does not claim global ordering between external events from different handlers.

## Root path

- Before: a root PATCH could perform a root session write followed by another whole-session write.
- After: root and all other supplied session fields use one `BEGIN IMMEDIATE` transaction and one session UPSERT.
- Canonicalization: before the DB transaction.
- LiveIndexer side effects: after commit.
- A LiveIndexer failure after commit is reported; no distributed rollback was introduced.

## Stress harness

- Command: `npm run test:sqlite-stress`
- Script: `scripts/sqlite-lock-stress.mjs`
- Rust helper: `rust/crates/tagimage-db/examples/sqlite-stress-tool.rs`
- Isolation: `.run/sqlite-stress/<label>/run-N`
- Default fixtures: 120 PNG images generated with Node standard modules
- Runtime: real API, four-slot thumb worker, metadata worker, and LiveIndexer
- Metadata jobs: inserted through production `enqueue_sqlite_metadata_job()`
- API samples: 25 create-tag, 25 update-tag, 25 image-tag, 25 session, 10 rebuild requests, an explicit three-write burst, and five concurrent session rounds
- Worker poll interval: production-equivalent `750 ms`; an early `20 ms` metadata poll was rejected because empty queue claims created artificial writer starvation
- Cleanup: process groups are stopped on success, failure, exception, SIGINT, and SIGTERM
- Exit status: non-zero on API errors, queue residue, failed jobs, duplicates, stale recovery, orphan temp files, fatal exits, or exhausted `DatabaseBusy`

## API write performance

The table uses the median of three equivalent per-run metrics. `max` is the worst value across the three runs. Baseline and final both use 120 fixtures, production poll intervals, identical operations, and the same machine.

| Operation | Baseline median / p95 / max ms | Final median / p95 / max ms | Final errors |
| --- | ---: | ---: | ---: |
| create tag | 243 / 2,004 / 5,246 | 234 / 3,021 / 5,181 | 0 |
| update tag | 219 / 791 / 2,736 | 222 / 2,127 / 3,901 | 0 |
| image tags | 235 / 2,385 / 4,140 | 227 / 1,176 / 3,560 | 0 |
| mixed burst | 416 / 863 / 2,772 | 352 / 489 / 2,193 | 0 |
| session PATCH | 180 / 326 / 2,601 | 46 / 66 / 2,357 | 0 |
| thumb rebuild | 473 / 1,712 / 7,714 | 23 / 3,577 / 6,589 | 0 |

SQLite wait latency remains variable under simultaneous workers, as expected for a single writer. The final three-run candidate had zero exhausted `DatabaseBusy` responses and zero other API errors. Timeouts were not increased.

## Worker performance

- Baseline median throughput: `3.010 jobs/s` (`3.010`, `3.010`, `3.126`)
- Final median throughput: `3.197 jobs/s` (`3.328`, `3.197`, `2.979`)
- Baseline median final drain wait: `1.36 s`
- Final median final drain wait: `6.16 s`
- Final three runs: 360 metadata jobs and 428 thumb jobs succeeded in total
- Worker pacing experiments at 1, 5, 10, and 20 ms did not meet the repeated reliability gate and were removed.

No throughput regression was measured after retaining only the API blocking-task isolation.

## Tokio responsiveness

The production-poll baseline repeatedly showed non-DB `GET /` max latency of `2.7-4.1 s` during concurrent writes, matching DB probe spikes. This demonstrated Tokio runtime-thread starvation from synchronous SQLite waits.

Narrow `spawn_blocking` isolation was tested and kept for create/update tag, image-tag replacement, session PATCH, and thumb rebuild. Each closure opens and uses its SQLite connection inside the blocking task and returns owned data.

| Concurrent probe | Baseline p95 / max ms | Final p95 / max ms |
| --- | ---: | ---: |
| non-DB `/` | 102 / 4,126 | 14 / 48 |
| `/api/status` | 108 / 4,128 | 23 / 129 |
| `/api/images` | 103 / 4,126 | 18 / 217 |

- Runtime starvation demonstrated: yes
- `spawn_blocking` tested: yes
- `spawn_blocking` kept: yes, only on the five measured write routes

## Final invariants

Across all three final candidate runs:

- queued jobs: 0
- running jobs: 0
- failed jobs: 0
- duplicate attempts: 0
- duplicate terminal events: 0
- stale recoveries: 0
- orphan attempt temp files: 0
- exhausted `DatabaseBusy`: 0
- fatal or unexpected worker exits: 0

The final exact `npm run test:sqlite-stress` run also passed with 120 metadata jobs and 164 thumb jobs.

## Validation

- `cargo fmt --all --manifest-path rust/Cargo.toml -- --check`: passed
- `cargo check --manifest-path rust/Cargo.toml --workspace`: passed
- `cargo test --manifest-path rust/Cargo.toml --workspace`: passed (24 API, 6 metadata, 14 thumb, 7 core, 49 DB tests)
- `npm run typecheck`: passed
- `npm run build:frontend`: passed
- `npm run test:e2e`: passed
- `npm run test:sqlite-stress`: passed
- targeted clean live-filesystem startup/E2E/stop: passed `5/5`
- `git diff --check`: passed
- final API, thumb worker, and metadata worker state: stopped

## Decision

**KEEP**

Session correctness, the reproducible stress infrastructure, and narrowly measured `spawn_blocking` isolation satisfy the Phase C gates. Speculative worker pacing and unrelated write optimizations were reverted.

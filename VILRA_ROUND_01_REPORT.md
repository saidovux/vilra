# VILRA ROUND 01 REPORT

## A. Initial state

- Starting HEAD: `178ad2f1c63658dad16a3055972cc013e1dbd83d`
- Branch: `main`
- Initial working tree: clean.
- Source diagnostic JSON: available at
  `~/.local/share/app.tagimage.desktop/diagnostics/long-scroll-1791050465-861-211329-1.json`.
- Production SQLite: available at
  `~/.local/share/app.tagimage.desktop/tagimage.sqlite` and inspected read-only.
- Diagnostic AppImage: available at
  `.run/diagnostics/autonomous-gallery-20261003/Vilra_0.1.1_diagnostics_amd64.AppImage`.
- Stable AppImage: `rust/thumb-worker/target/release/bundle/appimage/Vilra_0.1.1_amd64.AppImage`.
  It was not overwritten.

The diagnostic session ran from `2026-10-03T18:01:05.707Z` for 600238 ms in
Tauri/WebKitGTK. It recorded 84 successful queue samples, 666 fallback HTTP 202
responses, and 44 stale running thumbnail jobs in every sample.

## B. Investigation of the 44 stale jobs

The production database currently has 45 stale running thumbnail jobs. Exactly
44 have `updated_at` before the diagnostic session. The additional job belongs
to diagnostic worker `rust-thumb-1791050456` and was claimed during that session.

For the original 44 rows:

- all are `thumb` jobs in `running` state;
- all are attempt 1 of 5;
- timestamps range from 2026-09-12 through 2026-10-02;
- all 44 have one `enqueued` and one `started` event, with no terminal event;
- all 44 attempt rows remain `running`;
- all 44 image rows exist and are active (`hidden = 0`);
- all 44 original files exist;
- none of the 44 thumbnail files exists;
- no duplicate active dedupe key was found.

The diagnostic JSON does not contain job IDs, so it cannot directly prove that
each of the 84 samples contained the same IDs. The database timestamps and the
unchanged count strongly support that conclusion, but it remains an inference.

The exact event that originally stopped each old attempt cannot be reconstructed
from the available logs. The reason they persisted is confirmed: a `running` job
is not claimable, active deduplication does not create a replacement, and the
packaged worker used for the diagnostic session had neither startup recovery nor
runtime recovery in its binary.

The worker log contains no `stale_recovery` entry. The diagnostic worker continued
to finish hundreds of other jobs, which explains why normal queue throughput and
the stale set coexisted.

## C. Startup recovery

The source tree already called stale recovery before starting worker slots, but
the extracted diagnostic AppImage worker did not contain the recovery log/code
marker. Packaging could copy a stale binary because Cargo honored an external
`CARGO_TARGET_DIR` while `prepare-tauri-sidecars.mjs` copied from a hard-coded
target directory.

The packaging script now builds and copies from the same explicit target
directory. Startup recovery now always logs its complete result, including zero.

An isolated packaged-runtime test started with one stale running job. The new
AppImage logged:

```text
stale_recovery phase=startup checked=1 recovered=1 requeued=1 failed=0
```

The job was reclaimed as attempt 2, succeeded, and produced a valid 640x400 JPEG.

## D. Runtime recovery

Previously, a job that became stale after startup remained `running` until an
application restart. The worker now performs bounded periodic recovery while the
application remains open.

Each worker slot has a separate SQLite heartbeat connection. A heartbeat updates
`updated_at` only when job ID, `running` state, worker ID, and attempt all still
match. Runtime recovery therefore ignores live long-running work and only
requeues or fails expired claims. Recovery errors are logged and do not terminate
the worker loop.

The heartbeat interval is derived from the stale timeout and bounded to 250 ms to
30 seconds. Runtime recovery is derived from the same timeout and bounded to 500
ms to 60 seconds.

## E. Concurrency and ownership

- Queue claim remains atomic through the existing SQLite claim transaction.
- Heartbeats are scoped to owner and attempt.
- Existing success/failure finalization verifies the current owner and attempt.
- Attempt-specific temporary thumbnail names prevent workers from sharing a temp
  file.
- Final publication happens only after current ownership is verified inside the
  finalization transaction.
- A resumed stale attempt cannot refresh, publish, succeed, or mutate the newer
  attempt. It only removes its own attempt-specific temporary file.

The regression test recovers an old claim, lets a new owner claim the next
attempt, then resumes the old claim. The old publisher callback is not invoked,
the final target is not removed, and the new attempt publishes a valid JPEG and
finishes successfully.

## F. Error and terminal behavior

- Retryable render, file-read, or publish failures continue through the existing
  retry/backoff path.
- Recovery requeues stale jobs while attempts remain and marks them failed after
  `max_attempts` is exhausted.
- Stable permanent decode/unsupported-content errors create a file issue and a
  terminal job failure.
- `/thumb/:id` returns HTTP 422 for a permanent image issue rather than returning
  HTTP 202 forever.
- The frontend already treats that 422 as terminal, stops retrying, removes the
  unavailable card, and refreshes Problems/gallery state.
- Frontend fallback retries are bounded; no frontend change was needed in this
  round.
- A stale or failed thumbnail job alone does not prevent `/file/:id` from serving
  a valid original. A permanent source-image issue intentionally makes the source
  unavailable as well.
- Active-job deduplication does not block a later job after the previous job is
  terminal.

## G. Fixes

### `rust/crates/tagimage-db/src/sqlite_runtime.rs`

Added an ownership- and attempt-scoped heartbeat update. Its test proves that the
old owner cannot heartbeat after recovery and a new claim.

### `rust/thumb-worker/src/main.rs`

Added per-slot claim heartbeat, periodic runtime stale recovery, complete startup
and runtime recovery logging, and worker build identity. Tests cover live-heartbeat
protection, runtime stale recovery, valid JPEG generation, zero-candidate startup,
and a late old attempt that cannot publish over the new attempt.

### `rust/api-server/src/db.rs`

Queue degradation now uses active running jobs (`running - stale_running`). The
test covers the observed `running=44`, `stale=44`, `queued>0` condition.

### `scripts/prepare-tauri-sidecars.mjs`

Build and copy now use one explicit target directory. Sidecars receive and log a
build identity derived from HEAD plus dirty state. This removes the confirmed
stale-sidecar packaging path.

## H. Verification

### Rust

- `cargo fmt --all -- --check`: passed.
- `cargo check --workspace`: passed.
- `cargo test --workspace`: passed.
- Workspace test totals included API 26, metadata worker 6, thumbnail worker 18,
  core 7, and database 51 tests.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.

### SQLite stress

Two isolated runs preserved all thumbnail queue invariants:

- stale running thumbnail jobs: 0;
- duplicate attempts: 0;
- duplicate terminal events: 0;
- all thumbnail jobs succeeded.

The overall stress command still reports failure from the pre-existing concurrent
tag-writer case (`delete sqlite suppressed auto tag: database is locked`, followed
by one `Tag not found`). The same failure exists in stored baseline runs and is
outside this thumbnail lifecycle round.

### Frontend

- `npm run typecheck`: passed.
- `npm run build:frontend`: passed.
- No frontend source was changed, so unrelated browser E2E was not required.

### Packaging and AppImage

- Release sidecars were built in `.run/round1-package/tauri-target`.
- The packaged worker contains `stale_recovery`, heartbeat diagnostics, and build
  identity `178ad2f1c636-dirty`.
- The normal Tauri bundling pass hit the host packaging tool's obsolete `strip`,
  which cannot read modern `.relr.dyn` sections. Packaging completed with the
  tool's supported `NO_STRIP=1` mode.
- Candidate AppImage:
  `.run/round1-package/output/Vilra-x86_64.AppImage`.
- SHA-256: `00d578a5165855cc04fb40c73a4bfd840cca2e8d6bad8ddea387116a16defd5b`.
- The stable AppImage retained its original timestamp and SHA-256
  `3973c00ccb8ef6f7a977adb4ad163c57896fbfe36f32a19a8938ed10f0b8aff5`.
- Packaged smoke used isolated XDG profiles and SQLite. API, metadata worker,
  and four thumbnail slots started. Startup recovery reclaimed a seeded stale
  job and produced a valid JPEG. A second smoke used the user-requested library
  `/home/user/data/images/art` with an isolated SQLite database; indexing and
  thumbnail processing started successfully with no stale running jobs observed.
  All smoke processes were stopped afterward.

### Data safety

- Production SQLite inspection: read-only.
- Production mutations performed: none.
- Original image mutations performed: none.
- The final smoke used `/home/user/data/images/art` at the user's request. Normal
  application behavior generated 15 missing cache thumbnails under that root.
- Backup status: not required because no repair or write was performed.

## I. Final status

```text
Starting HEAD: 178ad2f1c63658dad16a3055972cc013e1dbd83d
Final working tree: local uncommitted Round 1 changes and this report
Branch: main

44 stale jobs:
  Cause: original interruption unknown; persistence caused by missing packaged
         recovery plus no runtime recovery/heartbeat
  Fix: heartbeat, runtime recovery, startup observability, deterministic packaging
  Verification: isolated unit tests and packaged stale-job smoke passed

Startup recovery:
  Status: verified in packaged runtime for zero and one stale job

Runtime recovery:
  Status: implemented and verified on isolated SQLite

Attempt ownership:
  Status: owner/attempt heartbeat and late-owner publication protection verified

Terminal jobs:
  Status: existing bounded retry/permanent-error behavior verified by tests/code

Black thumbnails:
  PARTIAL
  The reproduced stale-job cause is fixed in isolated tests and the packaged
  runtime. Production data was intentionally not repaired, and the diagnostic
  data does not prove that every black card had this cause.

Original image availability:
  Status: independent of non-terminal thumbnail lifecycle; unchanged

Production SQLite:
  Read-only inspection: YES
  Mutations performed: NONE
  Backup status: NOT REQUIRED

Tests:
  Rust: PASS
  SQLite stress: THUMBNAIL INVARIANTS PASS; known baseline tag-lock case FAILS
  Frontend: TYPECHECK PASS, BUILD PASS
  AppImage: BUILD PASS with NO_STRIP=1, packaged recovery smoke PASS

Remaining problems:
  - Existing SQLite stress tag-writer lock failure is outside Round 1.
  - The 45 production stale rows remain untouched and need normal startup recovery
    with the new build or a separately approved repair operation.
  - General long-scroll performance and non-job causes of black cards remain for
    later rounds.

Ready for ROUND 2:
  YES
  Reason: the thumbnail lifecycle defect is covered by ownership-safe recovery,
          regression tests, and an isolated packaged-runtime smoke test.
```

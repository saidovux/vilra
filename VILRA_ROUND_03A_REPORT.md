# Vilra Round 3A: Missing-Thumbnail Diagnosis

## Run

- Starting HEAD: `350f3d68cd2d9272db8ea2d5b24d16afbb5a8d36`
- Artifact used: `.run/round2/artifacts/diagnostic/Vilra_0.1.1_round2_diagnostic_amd64.AppImage`
- Test data: hardlink-isolated copy at `.run/round3a/library`
- SQLite: `.run/round3a/runtime/tagimage.sqlite`
- Profile: `.run/round3a/profile`
- Missing-thumbnail setup: 3,500 active thumbnail files were unlinked only in the isolated library copy. Originals and the Round 2 library remained unchanged.
- Worker slots: 4, unchanged.
- Native scroll: 4,440 wheel events over 600 seconds, including a 45-second pause.

The Round 2 golden database remained intact: SQLite integrity check was `ok`, SHA-256 remained `50fa8b5fcf26b170c75c76c92638e2793c3da6f4a21abfea86e0ac3fb1d8840b`.

## Result

Was original slowdown reproduced: **PARTIAL**

The missing-thumbnail generation path reproduced the early gallery stall clearly. The diagnostic recorder itself stopped producing a full final report after its 121-second checkpoint, so the pause/recovery portion is evaluated from external telemetry rather than a complete browser trace. The gallery reached only index 287, compared with index 3,136 in the ready-thumbnail Round 2 diagnostic run.

### Before generation

- Runtime became ready with 8,879 indexed images and no active jobs.
- 3,500 selected thumbnail files were absent.
- Queue and running jobs were initially zero.

### Active generation

- Thumbnail generation started as soon as visible cards requested missing images.
- Peak queue: 83 by API sampling, 81 by SQLite sampling.
- Peak running jobs: 4 in SQLite sampling.
- Stale jobs: 0.
- 202 thumbnail jobs succeeded; 0 failed; 0 were skipped-existing.
- Active throughput reached 1.02 jobs/sec; total over the 600-second driver window was 0.34 jobs/sec.
- Worker metrics during generation reached `avg total_ms=604`, `avg render_ms=202`; later cumulative values were 443.5 ms and 142.9 ms.
- Completed job timing: total mean 443.5 ms, p50 348 ms, p95 1,095 ms, max 3,321 ms. Render mean 142.9 ms, p50 127 ms, p95 275 ms, max 845 ms.

### During slowdown

The diagnostic checkpoint covered the first 121 seconds:

- Loaded metadata: 288 images.
- Maximum visible index: 287.
- Pagination: 1 refresh plus 5 successful cursor requests.
- `/api/images` server timing: mean 8,972.6 ms, approximate p50 10,000 ms, max 15,886.2 ms.
- End-to-end pagination: mean 16,426.2 ms, approximate p50 30,000 ms, max 28,996 ms.
- Virtualizer stage: mean 2,083.3 ms, approximate p50 2,000 ms, max 6,304 ms.
- `renderVirtualGalleryRange`: mean 115.4 ms, approximate p95 750 ms, max 6,036 ms.
- First-visible thumbnails: 226 not ready, 0 ready.
- Primary thumbnail loads: 291 started, 0 successful, 148 errors.
- Fallback attempts: 178; observed HTTP 202 responses: 38; fallback HTTP 200 responses: 1.
- Fallback latency: mean 5,493.1 ms, approximate p50 10,000 ms, max 9,744 ms.
- Frame/rAF proxy: mean 68.2 ms, approximate p95 150 ms, max 4,504 ms; 83 intervals exceeded 50 ms.

### After 30-60 s pause

During the planned 45-second pause:

- Queue: 0.
- Running jobs: 0.
- New generated thumbnails: remained 202.
- Status request latency returned to approximately 17-33 ms.
- I/O pressure fell from active-generation levels to near zero.

After the pause and during the second scroll segment, no new pages or thumbnail jobs appeared. The gallery did not recover past index 287. This is why the overall result is PARTIAL rather than a complete reproduction of the Round 1 pause-recovery trace.

## Resource measurements

### Thumbnail queue and workers

- Peak queued: 83 observed.
- Peak running: 4.
- Stale: 0.
- Successful generated thumbnails: 202.
- Failed: 0.
- Worker slots stayed at 4.

### CPU and memory

During active generation, approximate process means were:

- Tauri desktop: 5.5% CPU.
- WebKit process: 14.2% CPU, sampled RSS up to 161,660 KiB.
- API server: 5.2% CPU.
- Thumbnail worker: 19.7% CPU, maximum sampled 32.7%, RSS up to 220,528 KiB.
- Metadata worker: approximately 0% CPU.

The worker was not CPU-saturated as a whole, but it was the dominant application CPU consumer and held the largest growth in RSS.

### Disk I/O and pressure

During the active-generation window, the thumbnail worker read approximately 138 MiB and wrote approximately 14.8 MiB. System I/O PSI averaged 60.06% `some` pressure and reached 73.78%. During the pause, I/O PSI averaged 1.79%; after the pause it was approximately 0.11%.

### SQLite contention and recovery

- No `database is locked` or `database busy` messages.
- Stale jobs: 0.
- Runtime recovery: checked 0 and recovered 0.
- No failed jobs were observed.

There is no evidence of a lock failure or stale-job recovery loop as the primary cause in this run.

## Primary bottleneck

**Missing-thumbnail request/generation pressure combined with heavy filesystem I/O and HTTP 202 retry latency.**

Evidence:

1. Removing only isolated thumbnail files caused generation to start on first visibility.
2. Queue depth rose to approximately 80 and four worker slots were active.
3. The same interval showed high I/O PSI, thumbnail-worker I/O, 202 fallback responses, and multi-second `/api/images` latency.
4. The virtualizer and render timings expanded by orders of magnitude compared with the ready-thumbnail Round 2 run.
5. Once generation and queue activity stopped, API/status latency and I/O pressure recovered, but the gallery remained stuck at the last loaded page.

The measurements establish the workload chain, but do not yet isolate whether the main shared-resource cost is thumbnail decode/resize, filesystem/database finalization, or frontend retry/pagination scheduling.

## Secondary effects

- HTTP 202 fallback retries kept visible cards in a pending state.
- Pagination and virtualizer updates became slow while generation was active.
- The browser diagnostic loop stopped producing a final report after its 121-second checkpoint.
- API latency recovered after the queue drained, while gallery pagination did not resume.

## Confidence

**MEDIUM**

The early slowdown is reproducible and the test is isolated, but the missing full diagnostic report and lack of a second run prevent a complete conclusion about pause recovery and the exact shared-resource bottleneck.

## Candidate fix for Phase B

1. Decouple missing-thumbnail generation and HTTP 202 retry work from interactive pagination; prevent retry storms from blocking gallery progress.
2. Instrument and bound thumbnail generation/finalization pressure, including filesystem and SQLite timing, without changing worker count yet.
3. Preserve page/virtualizer progress when thumbnails remain pending; thumbnail readiness must not gate loading the next image page.

Does Phase B need code changes: **YES**

Likely files/components:

- `static/src/main.ts`: thumbnail retry lifecycle and pagination/virtualizer interaction.
- `rust/api-server/src/handlers.rs`: `/thumb` enqueue, wait, and HTTP 202 behavior.
- `rust/api-server/src/db.rs`: image-page and thumbnail job database timing.
- `rust/thumb-worker/src/main.rs`: generation/finalization timing and queue behavior.
- `rust/crates/tagimage-db/src/sqlite_runtime.rs`: only if Phase B confirms SQLite write/finalization contention.

No source code, frontend, worker, API, or database schema was changed in Phase A. No AppImage was rebuilt. The report was subsequently committed and pushed separately, without any implementation changes.

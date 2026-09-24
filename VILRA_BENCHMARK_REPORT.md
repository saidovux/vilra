# Vilra Performance Benchmark Report

Test interval: 2026-09-23 16:41 to 2026-09-24 09:49 (Europe/Moscow; interrupted and resumed after host reboot)  
Tested commit: `b690824cc8cca8953a939f5b136e5a48fdcde0f6` (`b690824 new`)  
Branch: `main`  
Git state at start: clean  
AppImage: `/home/user/data/development/vilra/.run/benchmarks/full-audit-20260923T134024Z/cargo-target/release/bundle/appimage/Vilra_0.1.0_amd64.AppImage`  
AppImage SHA256: `e4804c74285c419ab78e72e622fef17471181adfa8d29226635dfce2d426e847`  
AppImage size: 111,503,864 bytes (106.34 MiB)  
Benchmark API ports: `39861`, `50177`, `53807`, `55857`, `35095`, `36103`, `42443`, `48077`, `51185`  
Production SQLite: `/home/user/.local/share/app.tagimage.desktop/tagimage.sqlite`  
Library size: 8,026 active images across two roots  
Storage: production SQLite on SATA SSD; main 8,010-image root and 4,187 thumbnails on a rotational SATA HDD  
Actual production runtime: **AppImage / WebKitGTK**  
Structural fallback runtime: **Playwright / Chromium**

## 1. Executive Summary

| Area | Runtime | Measured result | Status | Confidence |
|---|---|---|---|---|
| Startup | AppImage/WebKitGTK | API ready median 829 ms, max 844 ms | STRONG | High |
| Startup reconciliation | AppImage/WebKitGTK | Roots settled median 4.52 s; valid sync events median 1.56 s | OK | High |
| Idle CPU | AppImage/WebKitGTK | 0.99% aggregate average for six-process family | STRONG | High |
| Idle memory | AppImage/WebKitGTK | 373.9 MiB family PSS; +318 KiB over five minutes | OK | High |
| API | AppImage/WebKitGTK | First image pages median 155-166 ms; continuation 95-110 ms | OK | High |
| SQLite | Read-only production copy | Core image query median 67-83 ms; tag query 90-96 ms | OK | High |
| Thumbnail serving | AppImage/WebKitGTK | Median 38.1 ms first, 20.6 ms repeat; all HTTP 200 | OK | High |
| Original serving | AppImage/WebKitGTK | First 20-354 ms depending on size/cache; warm 20-67 ms | OK | High |
| Deep scroll DOM | Playwright/Chromium | 48 to 5,088 cards; 1,039 to 44,752 DOM nodes, retained at top | BOTTLENECK | High |
| Deep scroll memory | AppImage/WebKitGTK | Production WebKit deep-scroll PSS unavailable | NOT MEASURED | High |
| Scroll seamlessness | Playwright/Chromium | Normal: 86.7% loaded before visible; fast: 13.6% | CONCERN | High |
| Preview latency | Playwright/Chromium + AppImage API | 144 MP image: 4.76 s UI vs 354 ms first file response | BOTTLENECK | High |
| Preview memory | AppImage/WebKitGTK | No safe production WebKit automation | NOT MEASURED | High |
| Storage pressure | AppImage/WebKitGTK | Cold/warm original delta exists; idle I/O delay zero | OK | Medium |
| Workers | AppImage/WebKitGTK | Low idle CPU/PSS, but 36 stale running thumb jobs reported | CONCERN | High |

The strongest measured results are startup-to-API readiness, true idle behavior, problem queries, and warm file serving. The dominant frontend scaling issue is monotonic card/DOM retention. Fast scrolling also outruns thumbnail presentation. Large original preview latency is mostly outside HTTP serving and grows sharply with pixel count, which supports decode/canvas/rendering as the likely dominant layer.

## 2. Environment

- OS: EndeavourOS, Linux `6.18.52-1-lts`, x86_64.
- CPU: Intel Core i3-2310M, 2 cores / 4 threads, 2.10 GHz.
- RAM: 7.7 GiB; no swap.
- Session: Wayland (`WAYLAND_DISPLAY=wayland-1`).
- Root/SQLite device: `/dev/sda4`, ext4 on 256 GB SATA SSD, 94% used during inventory.
- Project/main image root: `/dev/sdb1`, ext4 on 320 GB 5400-RPM-class SATA HDD, 50% used.
- Production DB: 29,626,368 bytes plus 4,375,472-byte WAL at inventory time.
- Thumbnails: 4,203 files, about 235.2 MiB total; 4,187 are on the HDD root.
- Image sizes: median 699,700 bytes, p95 11,498,099 bytes, max 41,712,912 bytes.
- Pixel counts: median 3.87 MP, p95 24 MP, max 144 MP (`16000x9000`).
- Issues/tags: 12 errors, 15 warnings, 24 tags, 9,571 image-tag rows.

All requested tools were available. Detailed hardware, mounts, tool paths, versions, DB inventory, and thumbnail inventory are in `system.txt`, `tools.txt`, and `library.txt`.

## 3. Methodology

The AppImage was freshly built from the tested commit. An initial normal build failed because Cargo cache metadata contained an absolute path to a deleted checkout. The successful build used an isolated `CARGO_TARGET_DIR` under the raw artifact directory; no `cargo clean` or source change was used.

Linux page cache was **not** cleared. Startup figures are normal startup in a warm OS-cache environment, not cold-start claims. Startup used one exploratory run and five measured runs, each on a new free port with clean process-family shutdown.

Production AppImage/WebKitGTK supplied startup, process, PSS, CPU, I/O, API, thumbnail, original, and worker figures. Playwright/Chromium was used only for frontend structural behavior, visible-thumbnail latency, frame-interval proxy, and preview interaction latency. Chromium CPU/RAM is not presented as WebKit CPU/RAM.

User collections remained read-only. No image, tag, root, thumbnail, or production DB data was deliberately changed. SQLite plans and repeated query timings ran read-only against a backup copy made after clean AppImage shutdown. No `VACUUM`, `ANALYZE`, or `PRAGMA optimize` was run.

Production WebKit automation was timeboxed and stopped because Wayland had no `xdotool`/`wmctrl` path and the application exposes no safe inspector automation. Therefore production deep-scroll and preview memory are explicitly not measured.

## 4. Startup

### Measured runs

| Run | Port | API ready | Roots settled | Valid sync duration | Exit |
|---:|---:|---:|---:|---:|---:|
| 1 | 50177 | 823.384 ms | 4,410.810 ms | 1,457.611 ms | SIGTERM after clean stop |
| 2 | 53807 | 829.316 ms | 4,606.004 ms | 1,600.906 ms | SIGTERM after clean stop |
| 3 | 55857 | 843.757 ms | 4,590.252 ms | 1,594.759 ms | SIGTERM after clean stop |
| 4 | 35095 | 815.471 ms | 4,507.232 ms | 1,540.782 ms | SIGTERM after clean stop |
| 5 | 36103 | 842.755 ms | 4,522.645 ms | 1,564.261 ms | SIGTERM after clean stop |

| Metric | Min | Median | Mean | Max |
|---|---:|---:|---:|---:|
| Spawn to API ready | 815.5 ms | 829.3 ms | 830.9 ms | 843.8 ms |
| Spawn to roots settled | 4,410.8 ms | 4,522.6 ms | 4,527.4 ms | 4,606.0 ms |
| `sync_started` to `sync_finished` | 1,457.6 ms | 1,564.3 ms | 1,551.7 ms | 1,600.9 ms |

All five SSE sync measurements captured the start event and are valid. API readiness and roots-settled timing are separate metrics.

The instrumented strace run is **not comparable** to normal wall time. `APPIMAGE_EXTRACT_AND_RUN=1` was required because FUSE mounting failed under ptrace, so counts include extraction. It observed 50,963 file-related calls: 20,491 `statx`, 19,593 `newfstatat`, 6,494 `openat`, and 1,009 `readlink`; traced syscall time was 0.539 s.

## 5. Idle Efficiency

After roots settled and an additional 30-second wait, `pidstat` sampled for 60 seconds. PSS is the primary memory metric.

| Process | Avg CPU | PSS start | PSS end | RSS end | Read | Write | I/O delay | Context switches/s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Desktop | 0.12% | 122,152 KiB | 122,152 KiB | 228,832 KiB | 0.07 KiB/s | 0.27 KiB/s | 0 | 1.01 |
| Rust API | 0.10% | 17,730 KiB | 17,730 KiB | 20,400 KiB | 0 | 0 | 0 | 0 |
| Thumb worker | 0.37% | 4,035 KiB | 4,035 KiB | 6,548 KiB | 0 | 0 | 0 | 0 |
| Metadata worker | 0.13% | 3,145 KiB | 3,145 KiB | 5,520 KiB | 0 | 0 | 0 | 1.40 |
| WebKit network | 0.05% | 33,815 KiB | 33,760 KiB | 62,560 KiB | 0 | 0 | 0 | 0.39 |
| WebKit web | 0.22% | 192,996 KiB | 192,969 KiB | 302,684 KiB | 0 | 0 | 0 | 4.12 |
| **Family total** | **0.99%** | **373,873 KiB** | **373,791 KiB** | **626,544 KiB** | | | | |

Five-minute family PSS was 373,873, 373,791, 374,051, 374,055, 374,107, and 374,191 KiB at 0/60/120/180/240/300 seconds. Net growth was only 318 KiB (0.085%). The first attempted five-minute run was contaminated by operator use after 180 seconds and is archived but excluded.

Measured conclusion: once settled and untouched, Vilra is genuinely quiet and does not exhibit spontaneous short-term memory growth.

## 6. API Performance

Each endpoint had 15 requests against the production AppImage API. All recorded responses were HTTP 200.

| Endpoint/workload | Median total | p95 | Max |
|---|---:|---:|---:|
| `/api/status` | 20.2 ms | 31.0 ms | 37.0 ms |
| `/api/problems/summary` | 18.0 ms | 26.9 ms | 27.4 ms |
| `/api/tags` | 124.4 ms | 150.7 ms | 153.2 ms |
| Images default first page, total included | 156.0 ms | 184.9 ms | 195.3 ms |
| Date first pages | 155.1-159.0 ms | 168.1-186.0 ms | 170.3-198.4 ms |
| Path first pages | 162.7-163.1 ms | 182.0-182.7 ms | 192.7-197.3 ms |
| Size first pages | 165.0-166.4 ms | 188.2-195.5 ms | 196.1-199.7 ms |
| Date/path/size continuation pages | 95.1-109.5 ms | 126.1-222.3 ms | 137.2-247.6 ms |
| Frequent tag (`cosplay`) | 198.4 ms | 232.2 ms | 235.1 ms |
| Rare tag (`test`) | 193.8 ms | 216.2 ms | 220.3 ms |

The size-desc continuation p95/max is the noisiest image-page result. At the tested 8,026-image scale, API response latency is usable but leaves less headroom than status/problems endpoints.

## 7. SQLite Performance

Fifty read-only repetitions per operation ran against `production-copy.sqlite` using SQL shapes taken from `rust/crates/tagimage-db/src/sqlite_runtime.rs`.

| Operation | Median | p95 | Max |
|---|---:|---:|---:|
| Path ascending | 67.2 ms | 80.4 ms | 81.6 ms |
| Path descending | 67.5 ms | 75.9 ms | 84.6 ms |
| Date ascending | 80.9 ms | 94.9 ms | 101.1 ms |
| Date descending | 82.8 ms | 103.2 ms | 123.5 ms |
| Size ascending | 82.1 ms | 92.1 ms | 104.8 ms |
| Size descending | 83.2 ms | 103.9 ms | 128.1 ms |
| Image total | 54.0 ms | 64.0 ms | 67.4 ms |
| Frequent-tag include | 89.5 ms | 106.2 ms | 115.7 ms |
| Rare-tag exclude | 96.4 ms | 107.8 ms | 116.4 ms |
| Problems summary | 0.024 ms | 0.028 ms | 0.048 ms |
| Problems list | 0.240 ms | 0.369 ms | 0.474 ms |

Measured plan facts:

- Image queries search via `images_root_hidden_idx`; the issue exclusion searches `file_issues_severity_idx`.
- Every tested image sort uses temporary B-trees for `GROUP BY` and `ORDER BY`.
- Tag include/exclude also uses temporary B-trees for `COUNT(DISTINCT)`.
- The image total materializes/scans the filtered result and has a 54 ms median.
- Problems queries scan the tiny 27-row issue table and remain below 0.5 ms; optimizing them is unsupported by evidence.

SQLite is not the leading current bottleneck at this collection size. The temporary sorts are a scaling concern, not evidence that indexes should be changed without a larger-scale benchmark.

## 8. Thumbnail Serving

Sixteen existing cached thumbnails were requested once and immediately repeated. No cache file was deleted or rebuilt.

| Request | Median total | p95 | Max | HTTP |
|---|---:|---:|---:|---:|
| First in run | 38.1 ms | 135.1 ms | 367.6 ms | all 200 |
| Repeat | 20.6 ms | 34.8 ms | 38.8 ms | all 200 |

The first-read outlier shows storage/cache sensitivity for at least one file. Typical cached-thumbnail delivery is fast. Thumbnail generation throughput was not measured because manufacturing a backlog would modify cache state.

## 9. Original File Serving

| Category | Dimensions | Bytes | First total | Warm best total | First throughput |
|---|---:|---:|---:|---:|---:|
| Small | 720x1280 | 93,219 | 49.8 ms | 20.1 ms | 1.79 MiB/s |
| Medium | 1920x1270 | 702,828 | 40.1 ms | 20.7 ms | 16.73 MiB/s |
| Large | 4672x7008 | 11,515,659 | 235.3 ms | 28.4 ms | 46.68 MiB/s |
| High pixel | 16000x9000 | 18,993,334 | 353.7 ms | 33.9 ms | 51.21 MiB/s |

The large first/repeat delta is measured evidence of page-cache/storage effects. Even so, first HTTP delivery of the 144 MP file was 354 ms, far below its 4.76-second first preview visibility time.

## 10. Deep Scroll Scaling

These are Playwright/Chromium structural measurements, not production WebKit memory measurements. Missing thumbnails beyond existing cache coverage were browser-mocked to avoid writes; DOM scaling remains valid because card creation was unchanged.

| Stage | Runtime | Cards/img nodes | Loaded img | DOM nodes | Visible unloaded | Production PSS/CPU/disk |
|---|---|---:|---:|---:|---:|---|
| Initial | Playwright/Chromium | 48 | 24 | 1,039 | 0 | NOT MEASURED |
| ~500 | Playwright/Chromium | 528 | 480 | 5,272 | 7 | NOT MEASURED |
| ~1000 | Playwright/Chromium | 1,008 | 964 | 9,367 | 6 | NOT MEASURED |
| ~2000 | Playwright/Chromium | 2,016 | 1,956 | 18,034 | 10 | NOT MEASURED |
| ~3000 | Playwright/Chromium | 3,024 | 2,939 | 26,524 | 14 | NOT MEASURED |
| ~5000 | Playwright/Chromium | 5,040 | 4,911 | 44,368 | 6 | NOT MEASURED |
| Returned top +30 s | Playwright/Chromium | 5,088 | 4,954 | 44,752 | 0 | NOT MEASURED |

Measured fact: card, image, and total DOM counts grow approximately linearly with pagination depth, and old cards are not removed after returning to the top. This confirms DOM retention. The resulting production WebKit memory cost was not measurable safely, so the report does not assign a fabricated PSS slope.

Sidebar-toggle latency was 18.2 ms initially and 179.4 ms at ~5,000 cards, with noisy intermediate values of 78.6, 46.3, 92.3, and 90.6 ms. This supports, but does not alone prove, worsening main-thread responsiveness with DOM depth.

## 11. Scroll Seamlessness

The authoritative run stops around 1,000 cards where real cached-thumbnail coverage was verified.

| Mode | Runtime | Loaded before visible | Visible-to-loaded p50 | p95 | Max | Max visible unloaded | Samples with unloaded |
|---|---|---:|---:|---:|---:|---:|---:|
| Normal | Playwright/Chromium | 86.7% | 114.3 ms | 286.9 ms | 386.5 ms | 8 | 11.9% |
| Fast | Playwright/Chromium | 13.6% | 248.7 ms | 585.0 ms | 807.5 ms | 22 | 78.4% |

Frame intervals are a Chromium/driver structural proxy, not exact WebKit FPS:

| Mode | Frames | p50 | p95 | Max | >16.7 ms | >33 ms | >50 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Normal | 1,225 | 33.4 ms | 83.4 ms | 366.7 ms | 73.1% | 71.4% | 23.8% |
| Fast | 449 | 50.0 ms | 150.0 ms | 250.1 ms | 85.5% | 84.4% | 39.2% |

Measured conclusion: normal scrolling is usually prefetched but not fully seamless; fast scrolling regularly exposes unloaded content and materially worse frame intervals.

## 12. Return-To-Top Behavior

At the deepest point there were 5,040 cards and 44,368 DOM nodes. Immediately after navigating upward the page was still completing layout/pagination and held 5,088 cards. Thirty seconds after reaching `scrollY=0`, counts were unchanged: 5,088 cards, 5,088 image nodes, and 44,752 DOM nodes.

Measured fact: returning to the top does not release card DOM. Hypothesis: retained DOM and associated browser image/layout state contribute to the resource growth seen during long browsing sessions. Production PSS recovery remains unmeasured.

## 13. Preview Latency

| Category | Pixels | AppImage API first file | Chromium first visible | Approx. non-serving remainder | Second visible |
|---|---:|---:|---:|---:|---:|
| Small | 0.92 MP | 49.8 ms | 304.3 ms | 254.5 ms | 106.7 ms |
| Medium | 2.44 MP | 40.1 ms | 239.7 ms | 199.6 ms | 154.9 ms |
| Large | 32.74 MP | 235.3 ms | 1,554.6 ms | 1,319.3 ms | 667.6 ms |
| High pixel | 144 MP | 353.7 ms | 4,762.9 ms | 4,409.2 ms | 443.1 ms |

Measured fact: latency grows much more with decoded pixel count than with HTTP file-transfer time. Current code fetches an original Blob, decodes an Image, renders a full-size Canvas, and caches canvases. Therefore decode/canvas/rendering is the high-confidence likely source of most first-open latency for very large files; the benchmark did not instrument those sub-steps individually.

## 14. Preview Memory

**NOT MEASURED** for production AppImage/WebKitGTK. Safe automation could not open/navigate/close preview while sampling the correct WebKit process, and Chromium memory was intentionally not substituted.

Code fact: current preview uses full-resolution canvases, a canvas cache capped at nine entries, and neighbor preloading. Size fact: a single uncompressed RGBA canvas for the 16000x9000 sample would represent about 549 MiB before implementation-specific overhead/compression. This is a capacity hypothesis, not measured process PSS. Preview retention and release after close require a future instrumentable WebKit run.

## 15. Storage / HDD Analysis

### Measured

- The main image root and its 4,187 thumbnails live on a rotational SATA HDD; SQLite lives on the SATA SSD.
- Large original first reads were 235-354 ms versus 28-34 ms best repeat reads.
- Thumbnail median improved from 38.1 ms first to 20.6 ms repeat; one first request took 367.6 ms.
- During idle, every process had zero I/O delay; HDD utilization was usually zero with brief unrelated/light writes.
- Under a 20-second read-only API workload, `perf stat` recorded 132 requests, zero errors, 132 page faults, and zero major faults.

### Hypothesis

HDD latency affects uncached file opens, supported by first/repeat deltas. It is **not proven as the primary UX bottleneck**: high-pixel preview had about 4.41 s beyond first HTTP transfer, and fast-scroll/DOM evidence points strongly to frontend work. A synchronized production WebKit scroll trace with device I/O would be needed to attribute scroll stalls to the HDD.

## 16. Workers / Background Cost

| Worker | Idle CPU | PSS | Read/write | State |
|---|---:|---:|---:|---|
| Thumb worker (configured slots unchanged) | 0.37% | 4,035 KiB | 0 / 0 KiB/s | Queue depth 0 |
| Metadata worker | 0.13% | 3,145 KiB | 0 / 0 KiB/s | Running count 0 |

The filesystem mode was `live`, periodic scan was false, both roots were online/settled, and watcher overhead is included in idle process figures. Watcher event latency was not measured because user files could not be touched.

The status endpoint reported 36 stale/running thumb jobs while queue depth was zero (DB inventory had 37 running rows). This is a measured state-health concern even though it caused little idle resource use. Generation throughput was not measured because creating work would mutate thumbnail cache.

## 17. Strong Sides

- Production API becomes ready consistently in under 0.85 seconds on this older dual-core system.
- Idle family CPU is below 1%, worker PSS is small, and five-minute PSS is stable within 0.1%.
- Status and Problems summary endpoints complete near 20 ms end-to-end.
- Problems DB queries complete below 0.5 ms; no optimization evidence exists there.
- Warm thumbnail and original serving are fast, and all sampled file requests succeeded.
- Startup reconciliation of 8,026 indexed records settles consistently rather than showing long-tail instability.
- Process cleanup was reliable across startup, idle, and measurement sessions.

## 18. Bottlenecks

No **CRITICAL** bottleneck was established by the available production measurements.

### HIGH: unbounded gallery DOM retention

- Symptom: responsiveness and resource use can worsen with long scrolling.
- Evidence: 48 to 5,088 retained cards and 1,039 to 44,752 DOM nodes; no reduction 30 seconds after returning to top; sidebar proxy rose from 18.2 to 179.4 ms.
- Affected layer: frontend gallery rendering/layout.
- User impact: progressively heavier layout/style/event work in long sessions.
- Confidence: high for retention, medium for its exact production PSS/CPU cost.

### HIGH: high-resolution preview decode/render path

- Symptom: large originals open slowly.
- Evidence: 144 MP preview visible in 4.76 s while file HTTP completed in 354 ms; 32.7 MP preview took 1.55 s vs 235 ms HTTP.
- Affected layer: frontend decode/canvas/render/cache path.
- User impact: multi-second first open for very high pixel-count images.
- Confidence: high for layer attribution, pending sub-step profiling.

### HIGH: fast-scroll thumbnail gaps

- Symptom: blank/unloaded cards during rapid navigation.
- Evidence: only 13.6% loaded before visible, p95 585 ms after visibility, up to 22 visible unloaded images, unloaded content in 78.4% of samples.
- Affected layer: frontend lazy loading/prefetch/presentation under load.
- User impact: gallery does not feel continuous during fast scroll.
- Confidence: high in Chromium structural runtime; WebKit should be validated after an automation path exists.

### MEDIUM: image-query sort/count headroom

- Symptom: first gallery pages take 155-166 ms and tag pages about 194-198 ms end-to-end.
- Evidence: SQLite medians 67-96 ms plus 54 ms image total; plans use temporary B-trees for grouping/sorting/distinct.
- Affected layer: SQLite query shape and API request work.
- User impact: moderate filter/sort latency and possible scaling pressure beyond 8k images.
- Confidence: high at current size, medium for future scaling.

### MEDIUM: stale thumb job state

- Symptom: status reports 36 stale running thumb jobs with no queue backlog.
- Evidence: repeated settled status and DB inventory.
- Affected layer: queue state/recovery rather than active throughput.
- User impact: misleading health/state and potential future queue behavior risk.
- Confidence: high.

### LOW: uncached HDD file-read variance

- Symptom: occasional slower first thumbnail/original response.
- Evidence: first/repeat deltas and one 368 ms thumbnail outlier.
- Affected layer: storage/page cache.
- User impact: adds tens to hundreds of milliseconds to uncached loads, but does not explain multi-second preview cost.
- Confidence: medium.

## 19. Hypotheses For Next Optimization Phase

| Hypothesis | Evidence | Expected direction | Confidence |
|---|---|---|---|
| Bounding rendered cards will prevent depth-dependent frontend growth | DOM stays at 5,088 cards after return | Window/virtualize gallery while preserving scroll and masonry behavior | High |
| Earlier/adaptive image loading will reduce fast-scroll gaps | 13.6% preloaded and 585 ms p95 on fast scroll | Tune loading scheduling/preload based on direction/velocity | High |
| Pixel-bounded preview rendering will reduce high-res latency/capacity | 144 MP UI remainder ~4.41 s; full-size canvas code path | Decode/render to viewport-appropriate dimensions, preserving original access | High |
| Avoiding repeated temporary sort/group work may improve first/tag pages | Query plans use temp B-trees; 67-96 ms query medians | Re-evaluate query shape/index compatibility with larger datasets | Medium |
| Queue recovery semantics need inspection | 36 stale running rows at settled idle | Diagnose stale-state lifecycle before throughput tuning | High |
| HDD-aware read scheduling may smooth uncached loading | first/warm deltas | Measure synchronized WebKit scroll + block I/O before changing policy | Medium |

These are hypotheses and directions, not an implementation plan.

## 20. What NOT To Optimize Yet

- Do not optimize API process startup: measured readiness is consistently below 0.85 s.
- Do not change idle polling or worker count based on resource use: workers are small and quiet at idle.
- Do not optimize Problems SQL: sub-millisecond DB performance leaves no evidence-based gain.
- Do not treat SQLite itself as the primary bottleneck at 8,026 images.
- Do not redesign warm thumbnail/original serving: typical warm responses are already fast.
- Do not broadly blame or replace the HDD without synchronized workload evidence; it does not explain the preview residual.
- Do not tune AppImage packaging based on the instrumented strace extraction run.

## 21. Limitations

- Page cache was warm and intentionally not cleared; no cold-start claim is made.
- Production WebKit deep-scroll PSS/CPU/I/O and preview memory/release were not measurable without changing runtime configuration.
- Playwright results use Chromium and are structural/UX proxies, not WebKit resource figures.
- Request samples are 15 for API endpoints and 16 thumbnails; percentiles describe this test, not a service-level guarantee.
- The library has 8,026 records. SQLite conclusions should not be projected to much larger catalogs without another run.
- No synthetic disk benchmark was run, so storage conclusions come only from real application reads and idle telemetry.
- No thumbnail generation, watcher mutation, tag mutation, or root mutation workload was created for safety.
- The first idle and first seamlessness attempts were contaminated/out-of-scope and excluded; their raw files remain clearly suffixed.
- The host was rebooted during the audit. Completed artifacts were preserved and work resumed; no reported timing spans the interruption.
- `perf stat` covered a read-only API load, not production scrolling. The API process used 8.98 s task-clock over 20 seconds, 17.21B cycles, 29.84B instructions, 132 page faults, and zero major faults.

## 22. Raw Artifact Directory

All raw data, harnesses, logs, the read-only DB copy, calculations, and notes are in:

`/home/user/data/development/vilra/.run/benchmarks/full-audit-20260923T134024Z`

Primary artifacts include `appimage.txt`, `system.txt`, `tools.txt`, `library.txt`, `startup.csv`, `startup-strace.txt`, `idle-pidstat.txt`, `idle-process-memory.csv`, `idle-memory-5min.csv`, `api-latency.csv`, `thumbnail-serving.csv`, `original-serving.csv`, `sqlite-query-plans.txt`, `sqlite-query-times.csv`, `scroll-scaling.csv`, `scroll-seamlessness.csv`, `scroll-frame-times.csv`, `ui-depth-latency.csv`, `preview-latency.csv`, `perf-stat-api-load.txt`, and `benchmark-notes.txt`.

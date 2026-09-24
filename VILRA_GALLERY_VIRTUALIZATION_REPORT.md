# Vilra Gallery Virtualization Report

## Tested HEAD

Implementation and measurements were performed on `main` at
`b690824cc8cca8953a939f5b136e5a48fdcde0f6`. The requested starting HEAD was
unchanged. This work was not committed or pushed.

Baseline data is the read-only audit at
`.run/benchmarks/full-audit-20260923T134024Z`. New raw data is under
`.run/benchmarks/gallery-virtual-core-20260924T101515Z`.

## Dependency

- Package: `@tanstack/virtual-core` `3.17.11`
- License: MIT
- Reason: it supplies a framework-independent window virtualizer with lanes,
  deterministic estimates, stable keys, overscan, and official window-scroll
  observers while Vilra retains its existing vanilla TypeScript DOM and CSS.
- Unminified esbuild output: 134,757 bytes before, 192,493 bytes after. The
  57,736-byte (+42.8%) delta includes both TanStack and the new gallery logic.
- AppImage: 111,503,864 bytes before, 111,532,536 bytes after, a 28,672-byte
  (+0.026%) increase.

No React, Vue, Solid, Svelte, or adapter package was added.

## Architecture Before

The old gallery appended every paginated card permanently, placed cards through
custom shortest-column bookkeeping, and gated thumbnails with a gallery-wide
`IntersectionObserver`. At 5,040 cards it retained 44,368 DOM nodes; returning
to the top retained 5,088 cards and 44,752 nodes.

## Architecture After

The gallery is a TanStack-driven window virtual canvas. Metadata remains
cursor-paginated in `allImages`/`visibleImages`, while only the current virtual
range is mounted. A map keyed by image ID reuses mounted cards and removes cards
outside the range. Live filesystem events update metadata and invalidate the
virtual layout without introducing another renderer.

The old append renderer, lazy observer, sentinel, rendered counter, loaded-ID
set, and custom masonry column/height state were removed.

## TanStack Configuration

- `lanes`: responsive lane count derived from actual gallery width, 10px CSS
  gap, and the existing 230px minimum column target.
- `laneAssignmentMode`: `estimate`.
- `estimateSize`: deterministic image aspect-ratio geometry.
- `gap`: supplied once by TanStack; it is not included in item height.
- `overscan`: 20 items.
- `scrollMargin`: gallery document offset, recomputed on layout invalidation and
  resize.
- `getItemKey`: stable `visibleImages[index].id`.
- Scrolling: `observeWindowRect`, `observeWindowOffset`, and `windowScroll`.

## Exact Masonry Geometry

For gallery width `W`, gap `G`, and `L` lanes, lane width is
`(W - G * (L - 1)) / L`. With the card's one-pixel border, content width is
`laneWidth - 2`, image height is `contentWidth / aspectRatio`, and outer card
height is `imageHeight + 2`. Absolute positioning is applied to a
`.virtual-card-slot`; the existing `.card:hover` transform therefore cannot
overwrite virtual placement.

The synthetic test checked actual slot positions against virtual geometry after
deep scrolling and after resize. Maximum accepted drift was below 2px, with no
cumulative collapse.

## Card Mount/Unmount Lifecycle

The virtual range is diffed against `Map<imageId, mountedCard>`. Existing cards
remain mounted, new IDs are created, and obsolete IDs are unmounted. Unmounting
clears thumbnail retry timers, removes image handlers, revokes fallback object
URLs, removes the slot, and releases map references. Stable IDs survive
pagination, live updates, reverse scrolling, and remounting.

## Thumbnail Loading Strategy

Mounted virtual items start loading immediately with `loading="eager"` and
`decoding="async"`; unmounted items have no DOM node and make no request.
Actually visible cards receive `fetchPriority="high"`, while overscan cards use
`auto`. The separate 320px lazy-observer gate was removed.

The primary `/thumb-file/:id.jpg?v=mtime` path and `/thumb/:id?v=mtime`
fallback remain. Existing 202 retry and terminal 422 behavior are preserved.
Successful fallback fetches are displayed from their response blob, avoiding a
second request for the same fallback URL.

## Pagination Prefetch

Page size remains 48 and cursor semantics are unchanged. A next page is
requested when the last virtual item enters a threshold of at least one page
from the loaded end. `activePageLoad` serializes requests; both production-data
measurement and the 5,040-item synthetic test observed maximum image-page
request concurrency of 1.

Deep session restoration loads pages sequentially until virtual content can
cover the saved offset, then restores the window offset. No metadata bulk-load
or parallel cursor requests were added.

## DOM Scaling Before/After

Chromium measurements against the fresh AppImage API:

| Stage | Before cards | After cards | Before DOM nodes | After DOM nodes |
|---|---:|---:|---:|---:|
| Initial | 48 | 35 | 1,039 | 928 |
| ~500 | 528 | 65 | 5,272 | 1,243 |
| ~1,000 | 1,008 | 60 | 9,367 | 1,186 |
| ~2,000 | 2,016 | 65 | 18,034 | 1,237 |
| ~3,000 | 3,024 | 65 | 26,524 | 1,228 |
| ~5,000 | 5,040 | 65 | 44,368 | 1,198 |
| Returned top, settled | 5,088 | 35 | 44,752 | 928 |

The immediate return-to-top sample was still inside smooth window scrolling;
the settled five-second sample reached `scrollY=0` and released deep cards.

## Scroll Seamlessness Before/After

These are Playwright/Chromium presentation measurements, not production WebKit
memory or FPS figures.

| Mode | Loaded before visible | Visible-to-loaded p95 | Max visible unloaded | Samples with unloaded |
|---|---:|---:|---:|---:|
| Normal before | 86.7% | 286.9ms | 8 | 11.9% |
| Normal after | 100.0% | n/a (all completed before visibility) | 0 | 0% |
| Fast before | 13.6% | 585.0ms | 22 | 78.4% |
| Fast after | 97.6% | 318.1ms | 13 | 0.09% |

Normal scrolling exceeded the 95% target. Fast loading improved substantially
and exceeded the 70% stretch target, while its 318.1ms p95 narrowly missed the
300ms stretch target. The after fast run reached 720 metadata items before its
180-second safety guard, versus roughly 1,000 in the baseline; percentages are
therefore directional rather than perfectly depth-identical. The next measured
bottleneck is thumbnail availability/response latency during extreme jumps,
not retained card DOM. No custom velocity scheduler was added without stronger
evidence.

## Frame Proxy Before/After

RequestAnimationFrame intervals are Chromium/driver proxies only:

| Mode | Run | Frames | p50 | p95 | Max | >16.7ms | >33ms | >50ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Normal | Before | 1,225 | 33.4ms | 83.4ms | 366.7ms | 73.1% | 71.4% | 23.8% |
| Normal | After | 1,898 | 33.3ms | 100.0ms | 350.0ms | 54.0% | 51.8% | 17.9% |
| Fast | Before | 449 | 50.0ms | 150.0ms | 250.1ms | 85.5% | 84.4% | 39.2% |
| Fast | After | 8,629 | 16.7ms | 33.4ms | 350.0ms | 22.5% | 18.4% | 1.9% |

Fast-scroll frame distribution improved strongly. Normal p95 was noisier and
worse despite improved threshold percentages, so the report does not claim a
uniform frame-time win.

## UI-Depth Latency Before/After

The two-frame sidebar-toggle proxy measured 18.2ms to 179.4ms from initial to
~5,000 before virtualization, versus 15.6ms to 106.9ms after. Intermediate
after values were 23.7, 50.5, 58.8, and 150.0ms, so this noisy proxy improved at
the deepest point but still contains scheduler variance.

## Resize/Reverse-Scroll Behavior

Resize captures a visible stable-ID anchor, recomputes lane geometry, invalidates
TanStack measurements, and restores that anchor instead of scrolling to zero.
The synthetic test changed viewport width at deep scroll, observed a changed
lane count, retained an offset above 500px, and kept card/DOM bounds.

Deep-to-top and deep-to-top-to-deep passes remounted the expected IDs, removed
obsolete deep cards, retained unique mounted IDs, preserved the first image's
lane at the same width, and stayed within the card bound.

## Existing Regression Tests

- `npm run typecheck`: passed.
- `npm run build:frontend`: passed.
- `npm run test:e2e`: 19 passed, including existing live filesystem, preview,
  Problems, 202 retry, and 422 terminal behavior.
- Rust workspace format/check/tests: passed; 87 Rust tests passed.
- Tauri format: passed.
- The normal Tauri Cargo cache still referenced a deleted historical checkout;
  normal `cargo check` failed for that environmental reason. The required check
  and tests passed with a fresh isolated `CARGO_TARGET_DIR`; 2 Tauri tests passed.
- `npm run tauri:prepare`: passed.
- `git diff --check`: passed.

## Synthetic 5000-Item Test

`e2e/gallery-virtualization.spec.ts` serves 5,040 synthetic image records through
the real 48-item cursor contract and a tiny valid thumbnail. It verifies:

- at most 350 mounted cards and fewer than 4,000 total DOM nodes;
- serial pagination with unique cursors;
- unique stable image IDs;
- deep mount, top remount, deep unmount, and reverse scrolling;
- deterministic geometry drift below 2px;
- stable lane assignment at fixed width;
- responsive lane changes and retained deep position after resize.

The test passed both independently and as part of the full 19-test suite.

## AppImage Build

Fresh AppImage:

`src-tauri/.run/benchmarks/gallery-virtual-core-20260924T101515Z/appimage-target/release/bundle/appimage/Vilra_0.1.0_amd64.AppImage`

- Size: 111,532,536 bytes (106.37 MiB)
- SHA256: `06983e1ef5b95c4e8737aae93a750fa0e147ccfcc21aa5b524b67ccfe52df935`
- Build command: isolated `CARGO_TARGET_DIR`, `NO_STRIP=1 npm run tauri:build -- --bundles appimage`

The fresh AppImage launched, initialized its real WebKitGTK desktop process,
reported `db_ready=true`, `ready=true`, and settled both configured library
roots. Chromium then exercised the same fresh AppImage API and bundled frontend
for the quantitative runs. Safe automated interaction with the production
WebKit window was unavailable, so production WebKit memory and direct hover/
resize interaction are not claimed as measured.

## Remaining Limitations

- Fast-scroll p95 is 318.1ms, slightly above the 300ms stretch target.
- The fast after run hit its safety time limit at 720 loaded metadata records,
  reducing depth comparability with baseline.
- Smooth scrolling makes an immediate return-to-top snapshot transitional; the
  settled snapshot is bounded and correct.
- WebKitGTK memory and frame timing remain unmeasured without a safe desktop
  automation interface.
- `overscan=20` is intentionally simple. Larger overscan or a bounded,
  directional thumbnail preloader should only be considered after a controlled
  WebKit/HDD trace confirms the remaining 318ms tail.

## Raw Artifact Path

`.run/benchmarks/gallery-virtual-core-20260924T101515Z`

The directory includes raw CSV, JSON, AppImage logs, baseline/current bundles,
and `run-benchmark.sh`. Re-run with:

```bash
.run/benchmarks/gallery-virtual-core-20260924T101515Z/run-benchmark.sh /path/to/Vilra.AppImage
```

The harness blocks session writes, serially drives real cursor pagination, and
stops the AppImage process group when finished.

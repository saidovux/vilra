# VILRA Frontend Architecture Audit

Audit base: `46478ed10918dd94edec694378bbfdadc51b499e`

Scope: Electron renderer frontend after Round 01 through Round 02C-3. This is a source and test architecture review only. No benchmark, AppImage build, user database access, or runtime mutation was performed.

Finding labels used below:

- **Confirmed**: directly established from the current source or existing deterministic tests.
- **Potential risk**: a plausible failure or cost implied by the implementation, but not reproduced or measured in this audit.
- **Preference**: a maintainability recommendation, not a defect.

## 1. Executive Summary

The completed modularization rounds are a net improvement and should be kept. The frontend is no longer a single undifferentiated implementation: data normalization, query construction, gallery geometry, thumbnail request ownership, virtual-card DOM ownership, TanStack Virtual construction, and native preview mechanics now have identifiable module boundaries.

The current import graph is acyclic. `main.ts` is the composition root and no extracted module imports it. The gallery hot path is bounded by virtualization, while thumbnail requests have explicit generation, abort, timer, and Object URL ownership. The current Controller/View split around TanStack Virtual is operationally acceptable for the application's single-page lifetime.

No confirmed **Critical** or **High** severity architecture defect was found.

The principal remaining issue is not the raw size of `main.ts` but its ownership of many independently changing state machines. Gallery pagination, live filesystem events, tabs/session persistence, tags, Problems, Graph, viewer coordination, keyboard commands, and application startup all mutate module-level state in the same file (`static/src/main.ts:331-451`). This makes ordering dependencies easy to introduce and most behavior difficult to test without loading the full page.

One concrete behavior inconsistency was found: `applyLiveImage()` changes filtered membership for `image_updated` and `image_renamed`, but adjusts `serverTotal` only for `image_created` (`static/src/main.ts:895-934`). A live update that moves an image into or out of the active filter can therefore update the cards without updating the filtered total. This is a focused future bug fix, not a reason to redesign the event architecture.

Recommended next work is four small rounds: extract Problems, extract Graph, extract tab/filter/session state, then extract viewer coordination. Live-event orchestration and bootstrap should remain in `main.ts` until those feature boundaries exist.

## 2. Current Architecture

### Build and shell

- **Confirmed**: `static/src/main.ts` is the only frontend bundle entry. `npm run build:frontend` type-checks and bundles it to one browser IIFE with esbuild (`package.json:12`).
- **Confirmed**: `static/index.html` is a static application shell loaded before the deferred bundle (`static/index.html:10-404`). Its stable IDs form a runtime contract with `requireElement()` and the feature code.
- **Confirmed**: `static/src/styles.css` is global CSS. It contains several chronological override bands (`static/src/styles.css:968`, `1261`, `1651`, `2041`) rather than component-scoped styles.
- **Preference**: keeping one bundle and one static shell is appropriate for the current Vanilla TypeScript application. Modularization does not require a framework or multiple bundles.

### Extracted pure modules

- `gallery/image-data.ts` owns API image normalization, page parsing, total parsing, and stable first-page merge (`normalizeImageItem()`, `imagesFromRecord()`, `imagePage()`, `mergeRefreshedPageIntoLoadedImages()`).
- `gallery/image-query.ts` owns `/api/images` query parameters and the first-page/cursor `include_total` distinction (`buildImageQueryParams()`).
- `gallery/geometry.ts` owns aspect-ratio, lane, card-size, visibility, near-zone, and card-position formulas (`computeGalleryGeometry()`, `estimateVirtualCardSize()`, `virtualItemIsVisible()`, `virtualItemIsNear()`, `calculateVirtualCardLayout()`).
- `shared/helpers.ts` owns small JSON, number, array, clamp, and DOM lookup helpers.

These modules have no mutable application state and are independently exercised by `e2e/image-data.spec.ts` and `e2e/gallery-geometry.spec.ts`.

### Extracted stateful modules

- `gallery/thumbnail-lifecycle.ts` owns thumbnail fallback lifecycles, generations, requests, polling timers, abort controllers, and Object URLs (`ThumbnailLifecycleManager`, `static/src/gallery/thumbnail-lifecycle.ts:61-340`).
- `gallery/virtual-gallery-view.ts` owns the map of mounted card DOM nodes and mount/replace/position/unmount behavior (`VirtualGalleryView`, `static/src/gallery/virtual-gallery-view.ts:50-184`).
- `gallery/virtualizer-controller.ts` owns the single TanStack `Virtualizer` instance and its mount cleanup callback (`GalleryVirtualizerController`, `static/src/gallery/virtualizer-controller.ts:21-67`).
- `viewer/preview-modal.ts` owns native image loading, thumbnail fallback, stale-load generation, fit/1:1/zoom/pan geometry, and Viewer media release (`PreviewModal`, `static/src/viewer/preview-modal.ts:61-467`).
- `gallery-diagnostics.ts` owns opt-in diagnostics state, bounded aggregation, timers, PerformanceObserver, report UI, and Electron persistence (`GalleryDiagnostics`, `static/src/gallery-diagnostics.ts:378-1659`).

### Remaining composition root

`main.ts` remains responsible for:

- creating and connecting the extracted classes (`static/src/main.ts:434-451`);
- API calls and response-to-feature orchestration;
- tabs, filters, tag administration, selection, session persistence, settings, Problems, Graph, viewer coordination, keyboard commands, live filesystem events, and bootstrap;
- shared mutable arrays and state tokens (`static/src/main.ts:331-421`);
- direct DOM rendering not yet assigned to a feature module.

This is a recognizable composition root, but it still contains several feature implementations that can be extracted independently.

## 3. Module Dependency Map

```text
static/index.html
  -> static/dist/app.js (deferred)

main.ts
  -> shared/helpers.ts
  -> desktop-runtime.ts
  -> gallery-diagnostics.ts
       -> desktop-runtime.ts
  -> gallery/image-data.ts
       -> shared/helpers.ts
  -> gallery/image-query.ts
  -> gallery/geometry.ts
  -> gallery/thumbnail-lifecycle.ts
       -> shared/helpers.ts
       -> gallery-diagnostics.ts (type only)
  -> gallery/virtual-gallery-view.ts
       -> gallery/geometry.ts
       -> gallery/image-data.ts (type only)
       -> gallery-diagnostics.ts (type only)
       -> @tanstack/virtual-core (type only)
  -> gallery/virtualizer-controller.ts
       -> gallery/geometry.ts
       -> gallery/image-data.ts (type only)
       -> @tanstack/virtual-core
  -> viewer/preview-modal.ts
       -> shared/helpers.ts
```

- **Confirmed**: none of the extracted modules imports `main.ts`.
- **Confirmed**: no cycle exists in the audited graph.
- **Confirmed**: runtime dependencies point from orchestration to features and from features to lower-level helpers. Type-only diagnostics and image imports do not create runtime back-edges.
- **Preference**: future modules should continue to receive narrow callbacks or data snapshots rather than importing the composition root.

## 4. State Ownership

| State | Current owner | Assessment |
|---|---|---|
| Loaded images, visible images, filtered total, cursor, request generation | `main.ts:331-352` | **Confirmed** coherent pagination state, but spread across several globals and functions. |
| Tabs, active tab, filters, scroll restoration, delayed session save | `main.ts:337-341`, `1678-1987`, `3395-3488` | **Confirmed** one logical feature without one explicit owner. Good extraction candidate. |
| Tag pool and metadata | `main.ts:333-334`, `1666-2114`, `3787-3966` | **Confirmed** shared by Gallery, Viewer, Settings, and Graph. Requires a narrow shared read model before extraction. |
| Mounted card nodes | `VirtualGalleryView.mountedCards` | **Confirmed** single owner; external access is limited to `getMounted()` and `forEachMounted()`. |
| TanStack instance and mount cleanup | `GalleryVirtualizerController` | **Confirmed** single owner. Cleanup is retained but no application disposal path calls it. |
| Thumbnail async resources | `ThumbnailLifecycleManager.lifecycles` and `generation` | **Confirmed** single owner with explicit stale checks and release paths. |
| Scroll speed/admission policy | `main.ts:408-419`, `3507-3611` | **Confirmed** orchestration owner; the lifecycle manager intentionally does not decide visibility priority. |
| Preview image mechanics | `PreviewModal` | **Confirmed** single owner for native image and geometry state. |
| Preview source, page crossing, filmstrip, tags, UI modes | `main.ts:353-378`, `2611-3210` | **Confirmed** coordination remains outside `PreviewModal`, avoiding overloading the low-level modal but leaving a large feature block in `main.ts`. |
| Problems list, summary, polling, stale tokens | `main.ts:390-406`, `1011-1273` | **Confirmed** cohesive state machine embedded in the composition root. |
| Graph simulation and canvas UI | `main.ts:383`, `2126-2547` | **Confirmed** lazily initialized and internally cohesive, but mixed with global image/tag/filter access. |
| Diagnostics | `GalleryDiagnostics` singleton | **Confirmed** self-contained, opt-in, and bounded; it receives only two integration callbacks from `main.ts:4179-4184`. |
| Workspace and startup order | `main.ts:389`, `3993-4192` | **Confirmed** implicit module-level lifecycle. |

### Callback assessment

- `GalleryVirtualizerController` receives two dependencies: current images and `onChange` (`static/src/gallery/virtualizer-controller.ts:14-17`).
- `VirtualGalleryView` receives four operational callbacks plus a diagnostics port (`static/src/gallery/virtual-gallery-view.ts:26-36`).
- `ThumbnailLifecycleManager` receives four operational callbacks plus a diagnostics port (`static/src/gallery/thumbnail-lifecycle.ts:33-39`).
- `PreviewModal` receives one close callback (`static/src/viewer/preview-modal.ts:102-117`).

**Confirmed**: this is not callback proliferation. Each callback crosses a real ownership boundary and none reaches back by importing `main.ts`. The diagnostics ports are verbose but intentionally structural and keep the gallery modules independent of the diagnostics singleton.

## 5. Findings (Critical / High / Medium / Low)

### Critical

No confirmed Critical finding.

### High

No confirmed High finding.

### Medium

#### M1. `main.ts` owns multiple independent state machines

- **Confirmed**: more than 50 mutable module-level variables and sets are declared in `static/src/main.ts:331-421`.
- **Confirmed**: feature functions mutate neighboring feature state directly. Examples include live events mutating Gallery, Viewer, tags, folders, status, and Problems (`handleLiveEvent()`, `static/src/main.ts:837-893`), and tag updates mutating both image arrays, mounted cards, Viewer, and suggestion state (`updateImageTags()`, `static/src/main.ts:3184-3201`).
- **Impact**: correctness depends on call order and shared conventions rather than explicit feature boundaries. Isolated tests require loading the complete renderer.
- **Recommendation**: extract cohesive owners one feature at a time; do not replace the globals with one generic global store.

#### M2. Live update membership and filtered total can diverge

- **Confirmed code-path inconsistency**: `applyLiveImage()` removes/reinserts an updated image according to `imageMatchesActiveTab()`, but increments `serverTotal` only when `operation === 'created'` (`static/src/main.ts:919-930`). It never decrements for an updated image that leaves the active filter or increments for one that enters it.
- **Scope**: `image_updated` and `image_renamed` both use the `updated` path (`static/src/main.ts:843-845`).
- **Impact**: visible cards can be correct while `count-text` remains stale until a canonical refresh.
- **Evidence boundary**: the inconsistency is visible in source; this audit did not reproduce it against a live library.
- **Recommendation**: address as a small regression-tested fix before or during live-event extraction.

#### M3. TanStack lifecycle responsibility is split across Controller, View, and orchestration

- **Confirmed**: the Controller constructs the instance, calls `_didMount()` once, retains cleanup, and calls `_willUpdate()` (`static/src/gallery/virtualizer-controller.ts:31-39`).
- **Confirmed**: the View also calls `instance._willUpdate()` after card reconciliation (`static/src/gallery/virtual-gallery-view.ts:69-139`).
- **Confirmed**: `updateVirtualGalleryCount()` calls `ensure()`, then repeats `setOptions()` and `_willUpdate()` before View rendering (`static/src/main.ts:3712-3718`). That path can call `_willUpdate()` three times.
- **Confirmed**: `_didMount()` cleanup is stored but not exposed or invoked (`static/src/gallery/virtualizer-controller.ts:23-34`).
- **Assessment**: the current single-instance, application-lifetime use is acceptable and existing virtualization E2E tests cover pagination, reverse scroll, resize, stale cursor responses, and bounded DOM (`e2e/gallery-virtualization.spec.ts:484-678`). No current leak or rendering defect is proven.
- **Potential risk**: repeated private lifecycle calls add library-version coupling and may add avoidable synchronous work in update paths.
- **Recommendation**: do not change private TanStack calls speculatively. First add a focused lifecycle/call-order characterization test or profile the path; then consolidate ownership only if evidence supports it.

#### M4. Gallery server state and live-event state use parallel semantics

- **Confirmed**: server pagination/filter/sort is represented by `buildImageQueryParams()` (`static/src/gallery/image-query.ts:14-24`), while live events reimplement active-filter and sort semantics in `imageMatchesActiveTab()` and `compareLiveImages()` (`static/src/main.ts:895-917`).
- **Potential risk**: future backend sort/filter changes can drift from the client implementation.
- **Potential risk**: sorting the currently loaded subset after a live mutation while retaining the previous `nextCursor` can interact poorly with keyset pagination during heavy filesystem churn. Dedupe prevents duplicate IDs, but cannot recover an item skipped by a changed cursor boundary (`static/src/main.ts:919-930`, `1372-1450`).
- **Mitigation already present**: sequence gaps and `sync_finished` trigger canonical refreshes (`static/src/main.ts:819-821`, `855-861`, `969-977`).
- **Recommendation**: when live events are eventually extracted, represent membership/ordering/total changes as a small tested reducer and preserve canonical refresh recovery.

#### M5. Graph is a cohesive feature mixed into the composition root

- **Confirmed**: Graph state, initialization, DOM listeners, model construction, simulation, canvas rendering, input handling, and filter actions occupy `static/src/main.ts:2126-2547`.
- **Confirmed**: it depends on only a small external surface: loaded/current images, active tab tags, normalization helpers, opening an image, and filter mutation (`graphImages()`, `openGraphImage()`, `toggleGraphTagFilter()`).
- **Impact**: it inflates the composition root and cannot be tested independently from the full page.
- **Recommendation**: extract a `GraphWorkspace` with explicit image/filter/open callbacks. Preserve the algorithm exactly in the extraction round.

### Low

#### L1. `allImages` is a loaded-page collection, not necessarily all catalog images

- **Confirmed**: pagination appends pages into `allImages`, while `serverTotal` can be larger and `hasMorePages` true (`static/src/main.ts:1275-1450`).
- **Preference**: a future state extraction should use names such as `loadedImages` and `filteredTotal`. Renaming alone is not worth a standalone round.

#### L2. Stale gallery responses are ignored but not canceled

- **Confirmed**: `activeImagesRequest` and `requestId` prevent stale refresh/cursor responses from mutating state (`static/src/main.ts:1292-1324`, `1372-1408`).
- **Confirmed**: `/api/images` fetches have no `AbortController`.
- **Potential risk**: rapid tab/filter/sort changes can leave obsolete local HTTP requests consuming work until completion. State correctness is protected.
- **Recommendation**: only add cancellation if instrumentation shows meaningful pressure; do not combine it with feature extraction.

#### L3. Initial Gallery rendering waits for tag refresh

- **Confirmed**: `refreshImages()` awaits `refreshTagPool()` before `applyFilter()` and virtual rendering (`static/src/main.ts:1339-1344`).
- **Potential risk**: a slow `/api/tags` request delays already available image metadata from appearing.
- **Recommendation**: measure or add a targeted latency test before changing order because tags affect several rendered surfaces.

#### L4. Global CSS has layered override history

- **Confirmed**: the stylesheet has multiple later override sections (`static/src/styles.css:968`, `1261`, `1651`, `2041`) and repeats selectors such as `#topbar`, `#filter-bar`, `.btn`, and Viewer selectors.
- **Impact**: this is a maintenance and regression-localization cost, not a demonstrated runtime defect.
- **Recommendation**: do not mix CSS cleanup into TypeScript modularization rounds. Audit CSS separately after the behavior modules stabilize.

#### L5. Bootstrap is correct but implicit

- **Confirmed**: the deferred script guarantees the shell exists before module-level element lookups (`static/index.html:404`). Initialization then runs in a fixed bottom-of-file order: actions, Preview, quick menu, diagnostics, filters, fish inputs, SSE, Problems polling, initial rendering, session load (`static/src/main.ts:4176-4192`).
- **Potential risk**: moving one initializer during refactoring can silently alter listener precedence or make callbacks observe incomplete state.
- **Recommendation**: keep this order unchanged until the final bootstrap round and capture it with a smoke test before moving it.

## 6. Performance Risks

No benchmark was run. The points below are complexity and allocation observations, not claims of measured slowdown.

### Positive properties already present

- **Confirmed**: Gallery DOM is bounded by TanStack Virtual plus overscan rather than catalog size (`GALLERY_OVERSCAN = 20`, `static/src/gallery/virtualizer-controller.ts:19-64`).
- **Confirmed**: the 5,040-image virtualization test checks pagination, reverse scrolling, resize, unique cards, and a DOM-card limit of 350 (`e2e/gallery-virtualization.spec.ts:3-6`, `484-570`).
- **Confirmed**: thumbnail admission is visibility/direction aware and pauses near admissions during fast scroll (`static/src/main.ts:3507-3603`).
- **Confirmed**: thumbnail polling is bounded by attempts and lifetime, and unmount aborts requests/timers/releases Object URLs (`static/src/gallery/thumbnail-lifecycle.ts:41-45`, `108-142`, `277-339`).
- **Confirmed**: diagnostics collection is opt-in and bounded by interval/event/marker caps (`static/src/gallery-diagnostics.ts:156-163`); runtime timers and observers are cleared by `cleanupRuntime()` (`1529-1551`).
- **Confirmed**: Viewer uses native `<img>` elements and generation checks, releases Object URLs, and invalidates late completions (`static/src/viewer/preview-modal.ts:141-282`).

### Concrete risks to measure

1. **Repeated loaded-array work during pagination.** Each cursor page constructs a `Set` from all loaded IDs and copies `allImages` to `visibleImages` (`static/src/main.ts:1413-1422`). This is O(N) per page and allocates at each step. It is acceptable at current page size unless measurement says otherwise.
2. **Live-event burst work.** Every image create/update performs `findIndex`, full-array sort, array copy, virtual invalidation, folder/tag refresh scheduling, and potential Viewer/Graph updates (`static/src/main.ts:919-956`). Debouncing protects folder/tag requests, but sorting and virtual invalidation are per event.
3. **Selection validation scans loaded images.** `updateImageSelectionUi()` creates a full ID set on every selection change (`static/src/main.ts:1478-1489`). This is a potential 10,000-item interaction cost, although selected-card DOM mutation remains bounded.
4. **Virtual render signatures allocate.** `cardRenderSignature()` uses `JSON.stringify()` over tags and metadata for each current virtual item on render (`static/src/gallery/virtual-gallery-view.ts:38-47`, `84-112`). The item count is bounded, but scrolling can make this a frequent allocation site.
5. **Anchor preservation performs synchronous layout reads.** `captureGalleryAnchor()` calls `getBoundingClientRect()` for every mounted card and sorts visible candidates (`static/src/main.ts:3638-3647`). It runs on explicit invalidation/resize/focus transitions, not on every scroll event.
6. **Tag UI is not virtualized.** Filter suggestions are capped at 80 (`static/src/main.ts:1919-1948`), but tag administration and sidebar rendering sort/render the complete tag pool (`static/src/main.ts:2004-2050`, `3861-3893`). Libraries with thousands of tags may expose this cost.
7. **Graph simulation has quadratic tag repulsion.** `simulateGraphTick()` compares every tag-node pair for up to 180 animation frames (`static/src/main.ts:2316-2365`). The total graph is capped at 1,000 nodes (`2126-2149`, `2260-2269`), but a tag-heavy graph can still be costly on weak hardware. This path only runs while Graph is open.
8. **Viewer tag/folder film modes scan the current source.** `previewFilmCandidates()` filters the loaded source on render (`static/src/main.ts:2885-2907`). Nearby mode is bounded, but tag/folder modes are O(N).
9. **Repeated `_willUpdate()` calls.** The count-update path crosses Controller and View lifecycle calls multiple times (`static/src/main.ts:3712-3718`, `static/src/gallery/virtual-gallery-view.ts:135`). Cost is unmeasured and must not be optimized without profiling.

### Retention and cleanup assessment

- **Confirmed**: mounted cards and thumbnail resources are released on unmount (`static/src/gallery/virtual-gallery-view.ts:172-183`).
- **Confirmed**: Preview timers and Object URLs are generation-scoped and released on open/close transitions (`static/src/viewer/preview-modal.ts:141-240`).
- **Confirmed**: Graph listeners are installed once because `ensureGraphState()` returns the existing state (`static/src/main.ts:2126-2163`), and its RAF is canceled on close (`2177-2185`).
- **Potential risk**: the Virtualizer cleanup callback has no disposal API. This is harmless for today's one-window lifetime, but should be addressed if the gallery root ever becomes mountable/unmountable without a page reload.

## 7. Main.ts Decomposition Candidates

Sizes below are approximate source spans, not a claim that every line can or should move.

| Area | Approximate span | Main dependencies | Coupling | Extraction risk | Maintenance value |
|---|---:|---|---|---|---|
| Application bootstrap and generic action routing | `247-451`, `3993-4192` (~400 lines) | Every feature, DOM shell, listener order | Very high | High | Medium after other extractions; low now |
| Folder/library and general Settings | `480-735` (~255 lines) | session, roots, Gallery refresh, Viewer/Graph close, DOM | Medium | Medium | Medium |
| Status and live events | `759-1009` (~250 lines) | Gallery, tags, folders, Problems, Viewer, SSE | Very high | High | High, but only after feature APIs exist |
| Problems | state at `390-406`, implementation `1011-1273` (~280 lines) | API, Settings visibility, Electron reveal, shared rendering helpers | Low to medium | Low | High |
| Gallery data/card orchestration | `1275-1665` (~390 lines) | pagination, diagnostics, selection, thumbnail lifecycle, View/Controller | High and performance-sensitive | High | Medium; keep until later |
| Tabs, filters, tag admin | `1666-2114`, helpers `3787-3966` (~630 lines) | session, Gallery refresh, cards, Viewer, Graph, multiple DOM surfaces | High | Medium to high | High |
| Graph | types at `126-244`, implementation `2126-2547` (~540 lines total) | image snapshots, active filters, open image, canvas DOM | Medium but narrow | Low to medium | High |
| Viewer integration | `2611-3210` (~600 lines) | Gallery pagination, tags, session, PreviewModal, filmstrip DOM | High | Medium to high | High |
| Keyboard and commands | `3212-3393` (~180 lines) | workspace context and all feature commands | Medium | Medium | Medium after feature controllers exist |
| Session load/save | `3395-3488` (~95 lines) | tabs, roots, Gallery startup, settings | High despite small size | Medium | High when paired with tab state |
| Virtual Gallery orchestration | `3494-3785` (~290 lines) | geometry, Controller, View, thumbnail admission, pagination, scroll | High and hot-path | High | Low immediately; recent rounds already improved it |
| Shared tag/render utilities | `3787-3999` (~210 lines) | tag pool/meta and many DOM surfaces | Medium | Medium | Medium as part of tag round |

### Best immediate candidates

1. **Problems** is the safest extraction. It already has its own state, request tokens, polling, list renderer, and API endpoints.
2. **Graph** is large but cohesive. Its external dependencies can be expressed as a small callback interface without moving shared state.
3. **Tabs/filter/session** provides high value but must be staged because Viewer restoration and Gallery pagination read the active tab.
4. **Viewer coordination** is valuable after tab/session APIs stabilize. `PreviewModal` itself should remain unchanged.

### Poor immediate candidates

- Gallery virtual orchestration is recent, performance-sensitive, and strongly covered by current E2E behavior. More movement now adds risk without a clear ownership win.
- Generic action routing cannot become meaningfully smaller until feature modules expose commands.
- Live events currently coordinate every major feature. Extracting them first would create a large callback surface or a premature event bus.

## 8. Proposed Refactoring Roadmap

### Round 03A: Problems workspace

**Goal**

Move Problems normalization, state, API requests, polling, rendering, and row actions into `static/src/problems/problems-workspace.ts`.

**Files**

- Add `static/src/problems/problems-workspace.ts`.
- Update `static/src/main.ts` only for construction, workspace visibility, live-event notification, and action delegation.
- Add focused tests beside the existing Problems E2E coverage.

**Do not change**

- API shapes or endpoints.
- Settings HTML/CSS.
- SSE protocol.
- recheck semantics or polling intervals.

**Risk**: Low.

**KEEP criteria**

- Problems state is owned by one object.
- `main.ts` does not retain duplicate Problems flags/timers.
- Summary failure remains independent from list failure.
- Stale list responses and queued refresh behavior remain unchanged.

**Tests**

- Existing Problems tests in `e2e/gallery-sqlite.spec.ts:434-636` and `776-844`.
- New focused tests for request-token stale protection and refresh coalescing.
- Full TypeScript, frontend build, Electron checks, and E2E gate.

### Round 03B: Graph workspace

**Goal**

Move `GraphState`, canvas listeners, graph construction, simulation, rendering, and graph controls into `static/src/graph/graph-workspace.ts`.

**Files**

- Add `static/src/graph/graph-workspace.ts`.
- Update `static/src/main.ts` to pass image snapshots, active-filter callbacks, and `openImageById`.

**Do not change**

- simulation constants, node cap, frame count, canvas geometry, visual styles, or filter semantics;
- Viewer or Gallery state ownership;
- Graph performance behavior during the extraction.

**Risk**: Low to medium.

**KEEP criteria**

- Graph listeners install once.
- RAF starts/stops exactly as before.
- no `main.ts` import from the Graph module;
- Graph current/all scope and tag-filter actions remain identical.

**Tests**

- Existing open/close and shortcut coverage in `e2e/preview-progressive.spec.ts`.
- Add deterministic Graph scope, node-cap, RAF-close, and filter callback tests.
- Do not benchmark or optimize in this round.

### Round 03C: Tabs, filters, and session model

**Goal**

Introduce a focused `GalleryTabsController` or equivalent that owns tabs, active tab, filter mutation, scroll position, and session serialization/normalization.

**Files**

- Add `static/src/gallery/gallery-tabs.ts`.
- Update `static/src/main.ts` and, only if useful, add pure tag normalization helpers under `shared/` or `gallery/`.

**Do not change**

- API pagination, Gallery View/Virtualizer, Viewer restoration behavior, keyboard mappings, HTML/CSS, or session response shape.
- Do not introduce a generic application store.

**Risk**: Medium to high.

**KEEP criteria**

- Active-tab access has one owner.
- Session round-trip preserves include/exclude tags, match/sort mode, last image, and scroll position.
- Filter changes still invalidate request generations and restore scroll exactly as before.

**Tests**

- Add direct tests for tab normalization and session serialization.
- Existing stale cursor, tab shortcuts, filters, Viewer restore, and Gallery anchor E2E tests.
- Full frontend and Electron gate.

### Round 03D: Viewer coordinator

**Goal**

Move Viewer source selection, cross-page navigation, filmstrip, Viewer metadata/tags, focus/inspector state, and quick-menu coordination into `static/src/viewer/preview-coordinator.ts` while retaining `PreviewModal` unchanged.

**Files**

- Add `static/src/viewer/preview-coordinator.ts`.
- Update `static/src/main.ts` to provide loaded-image/page/tag/session callbacks.

**Do not change**

- `PreviewModal` image pipeline, fit geometry, zoom/pan, thumbnail-first loading, `/file/{id}`, Gallery pagination, or keyboard semantics.

**Risk**: Medium to high.

**KEEP criteria**

- stale original loads remain unable to replace the current image;
- navigation crosses page boundaries and coalesces repeated input;
- close restores the correct Gallery anchor and session state;
- all true-fit tests remain unchanged.

**Tests**

- Full `e2e/preview-progressive.spec.ts`.
- Gallery pagination/stale-response tests.
- Focused coordinator tests with a fake `PreviewModal` boundary if achievable without a generic framework.

### Round 03E: Live-event reducer and bootstrap cleanup

**Goal**

After the feature controllers exist, isolate live-event interpretation into pure state transitions plus narrow feature notifications, then make bootstrap order explicit in one `bootstrap()` function.

**Files**

- Add `static/src/live-events.ts` or `static/src/gallery/live-image-state.ts`.
- Update `static/src/main.ts`.
- Do not create a general event bus.

**Do not change**

- SSE protocol, reconnect behavior, sequence-gap recovery, filesystem semantics, pagination protocol, or feature rendering order.

**Risk**: High.

**KEEP criteria**

- live create/update/rename/remove preserve card membership, order, total, Viewer state, tags, folders, and Graph notifications;
- the M2 filtered-total inconsistency has a deterministic regression test and is resolved;
- initialization order remains observable and unchanged.

**Tests**

- Existing live filesystem tests in `e2e/gallery-sqlite.spec.ts:215-315`.
- New reducer tests for membership transitions under include/exclude filters and all sort modes.
- sequence-gap, `sync_finished`, and startup smoke tests.

## 9. Tasks to Avoid

- Do not migrate to React, SolidJS, egui, or another framework solely to reduce `main.ts`.
- Do not rewrite the application or replace the existing working module graph.
- Do not put all current globals into one large `AppState` object; that changes syntax without creating ownership.
- Do not add a generic event bus, dependency-injection container, repository layer, or universal HTTP client.
- Do not modify TanStack private lifecycle calls without a focused reproduction, call-order test, or profile.
- Do not combine Controller and View merely to reduce callback count; their state ownership is currently distinct.
- Do not merge Gallery and Viewer thumbnail pipelines. Their admission, lifetime, and priority requirements differ.
- Do not optimize Graph, pagination arrays, tag rendering, or render signatures during extraction rounds. Measure separately.
- Do not split `gallery-diagnostics.ts` because it is large. It is cohesive, opt-in, bounded, and already isolated from normal feature ownership.
- Do not mix CSS override cleanup, HTML restructuring, visual redesign, or Electron/Rust/SQLite changes into frontend architecture rounds.
- Do not move bootstrap or generic command routing before feature controllers expose stable command methods.
- Do not extract modules that import `main.ts` or mutate its globals indirectly.

## 10. Final Recommendation

**KEEP** the Round 01 through Round 02C-3 architecture.

The current frontend has a healthy modular foundation:

- imports are acyclic;
- pure Gallery calculations are independently testable;
- stateful Gallery and Viewer resources have explicit owners;
- virtualization keeps DOM growth bounded;
- async thumbnail and preview work has stale-request protection and cleanup;
- diagnostics is isolated and opt-in;
- existing E2E coverage exercises 5,040-image virtualization, thumbnail admission, SQLite/live filesystem behavior, Viewer continuity, geometry, desktop bridge behavior, and diagnostics.

The next objective should not be an arbitrary line-count target. It should be reducing the number of unrelated state machines owned by `main.ts` while retaining `main.ts` as the composition root.

Proceed in this order:

1. Problems workspace.
2. Graph workspace.
3. Tabs/filter/session model.
4. Viewer coordinator.
5. Live-event reducer and explicit bootstrap only after the earlier boundaries are stable.

Before those rounds, or as part of the live-event round, add a small regression test for filtered-total changes caused by `image_updated`/`image_renamed`. Leave the current Virtualizer lifecycle unchanged until focused evidence justifies modifying private TanStack integration.

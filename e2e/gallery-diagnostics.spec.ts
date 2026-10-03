import {expect, test, type Page, type TestInfo} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const TOTAL_IMAGES = 5_040;
const PAGE_SIZE = 48;
const THUMBNAIL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

type DiagnosticReport = {
  session: {generation: number; state: string};
  depth: {loaded_metadata_count: number; maximum_visible_index: number};
  pagination: {outcomes: Record<string, number>};
  thumbnails: {
    card_mounts: number;
    first_visible_entries: number;
    ready_on_first_visibility: number;
    primary_load_success: number;
    primary_load_error: number;
    fallback_http_202: number;
    fallback_attempts: number;
    mount_lifecycles_with_202: number;
    mount_lifecycles_recovered: number;
    mount_lifecycles_failed: number;
  };
  resources: {
    observer_support: string;
    coverage: string;
    size_fields_support: string;
    observed_entries: number;
  };
  frame_intervals: {distribution: {count: number; p95_ms_approx: number | string}};
  queue_sampling: {requests_started: number};
  manual_slowdown_markers: Array<{marker: number; intervalStartMs: number}>;
  intervals: Array<{interval_start_ms: number; interval_end_ms: number; scroll_activity: number}>;
  pending_at_stop: {status_requests: number};
  important_event_tail: Array<{type: string}>;
};

function syntheticImage(index: number) {
  return {
    id: `synthetic-private-${String(index).padStart(5, '0')}`,
    path: `/secret-root/private-name-${String(index).padStart(5, '0')}.jpg`,
    thumb_url: `/thumb-file/synthetic-private-${String(index).padStart(5, '0')}.jpg`,
    width: 640 + (index % 7) * 80,
    height: 480 + (index % 9) * 70,
    size: 10_000 + index,
    mtime: TOTAL_IMAGES - index,
    tags: ['private-tag'],
    auto_tags: [],
    folder_tags: [],
    user_tags: ['private-user-tag'],
  };
}

async function installSyntheticMetadata(page: Page): Promise<{servedThrough: number; pageRequests: number}> {
  const state = {servedThrough: 0, pageRequests: 0};
  await page.route('**/api/events', route => route.abort());
  await page.route('**/api/images?**', route => {
    state.pageRequests += 1;
    const url = new URL(route.request().url());
    const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
    const end = Math.min(TOTAL_IMAGES, offset + PAGE_SIZE);
    state.servedThrough = Math.max(state.servedThrough, end);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {'server-timing': 'api-images;dur=3.5'},
      body: JSON.stringify({
        items: Array.from({length: end - offset}, (_, itemIndex) => syntheticImage(offset + itemIndex)),
        page: {
          total: url.searchParams.get('include_total') === '1' ? TOTAL_IMAGES : null,
          next_cursor: end < TOTAL_IMAGES ? String(end) : null,
          has_more: end < TOTAL_IMAGES,
        },
      }),
    });
  });
  return state;
}

async function diagnosticsApi(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean(window.__vilraGalleryDiagnostics))).toBe(true);
  return {
    start: () => page.evaluate(() => window.__vilraGalleryDiagnostics!.start()),
    stop: () => page.evaluate(() => window.__vilraGalleryDiagnostics!.stop()),
    mark: () => page.evaluate(() => window.__vilraGalleryDiagnostics!.mark()),
    report: () => page.evaluate(() => window.__vilraGalleryDiagnostics!.report()) as Promise<DiagnosticReport>,
    reportJson: () => page.evaluate(() => window.__vilraGalleryDiagnostics!.reportJson()),
    state: () => page.evaluate(() => window.__vilraGalleryDiagnostics!.state()),
    debugState: () => page.evaluate(() => window.__vilraGalleryDiagnostics!.debugState()) as Promise<Record<string, unknown>>,
  };
}

async function waitForGallery(page: Page): Promise<void> {
  await expect(page.locator('#gallery-screen')).toBeVisible();
  await expect(page.locator('.card[data-id]').first()).toBeVisible();
}

test('diagnostic lifecycle resets, survives hiding, exports private-safe JSON, and is idle while off', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await waitForGallery(page);
  await expect(page.locator('.card[data-id] img').first()).toHaveClass(/loaded/);
  const diagnostics = await diagnosticsApi(page);

  expect(await diagnostics.state()).toBe('off');
  expect(await diagnostics.debugState()).toEqual({
    state: 'off',
    queueTimerActive: false,
    queueRequestPending: false,
    refreshTimerActive: false,
    animationFrameActive: false,
    resourceObserverActive: false,
  });

  await page.locator('#settings-toggle').click();
  await page.locator('[data-action="open-gallery-diagnostics"]').click();
  await expect(page.locator('#gallery-diagnostics-panel')).toBeVisible();
  await page.locator('[data-action="toggle-settings"][data-open="false"]').click();
  await page.locator('#diagnostics-start').click();
  await page.evaluate(() => window.scrollBy({top: 900}));
  await page.locator('#diagnostics-mark').click();
  await page.locator('.gallery-diagnostics-hide').click();
  await expect(page.locator('#gallery-diagnostics-panel')).toBeHidden();
  await diagnostics.stop();

  const first = await diagnostics.report();
  const firstJson = await diagnostics.reportJson();
  expect(first.session.state).toBe('stopped');
  expect(first.manual_slowdown_markers).toHaveLength(1);
  expect(first.thumbnails.ready_on_first_visibility).toBeGreaterThan(0);
  expect(first.depth.maximum_visible_index).toBeGreaterThanOrEqual(0);
  expect(firstJson).toBeTruthy();
  expect(firstJson).not.toContain('/home/');
  expect(firstJson).not.toContain('fixture-');
  expect(firstJson).not.toContain('image_id');

  await page.evaluate(() => window.__vilraGalleryDiagnostics!.open());
  await page.locator('#diagnostics-copy').click();
  await expect.poll(() => diagnostics.state()).toBe('exported');
  expect(await diagnostics.reportJson()).toBe(firstJson);

  await diagnostics.start();
  await diagnostics.stop();
  const second = await diagnostics.report();
  expect(second.session.generation).toBe(first.session.generation + 1);
  expect(second.manual_slowdown_markers).toEqual([]);
  expect(await diagnostics.reportJson()).not.toBe(firstJson);
});

test('late queue response cannot mutate a stopped report', async ({page}) => {
  let releaseStatus: () => void = () => undefined;
  let statusStarted: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { releaseStatus = resolve; });
  const started = new Promise<void>(resolve => { statusStarted = resolve; });
  await page.route('**/api/status', async route => {
    if (route.request().headers()['x-vilra-diagnostics'] !== 'long-scroll') {
      return route.continue();
    }
    statusStarted();
    await gate;
    return route.fulfill({json: {queues: {
      thumb_queue_depth: 41,
      thumb_running: 2,
      thumb_stale_running: 0,
      metadata_running: 1,
    }}});
  });
  await page.goto('/');
  await waitForGallery(page);
  const diagnostics = await diagnosticsApi(page);
  await diagnostics.start();
  await started;
  await diagnostics.stop();
  const before = await diagnostics.reportJson();
  const report = await diagnostics.report();
  expect(report.pending_at_stop.status_requests).toBe(1);
  releaseStatus();
  await page.waitForTimeout(100);
  expect(await diagnostics.reportJson()).toBe(before);
});

test('thumbnail lifecycle separates repeated 202 attempts, recovery, failure, remount, and visibility', async ({page}) => {
  test.setTimeout(90_000);
  const synthetic = await installSyntheticMetadata(page);
  let releaseThumbnails: () => void = () => undefined;
  const thumbnailGate = new Promise<void>(resolve => { releaseThumbnails = resolve; });
  const fallbackAttempts = new Map<string, number>();
  await page.route('**/thumb-file/**', async route => {
    await thumbnailGate;
    const path = new URL(route.request().url()).pathname;
    if (path.includes('00150')) await new Promise(resolve => setTimeout(resolve, 300));
    if (path.includes('00000') || path.includes('00001')) {
      return route.fulfill({status: 404, headers: {'cache-control': 'no-store'}, json: {detail: 'Not found'}});
    }
    return route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL});
  });
  await page.route('**/thumb/**', route => {
    const path = new URL(route.request().url()).pathname;
    const count = (fallbackAttempts.get(path) || 0) + 1;
    fallbackAttempts.set(path, count);
    if (path.includes('00000') && count <= 2) {
      return route.fulfill({status: 202, json: {retry_after_ms: 1}});
    }
    if (path.includes('00001')) {
      return route.fulfill({status: 500, json: {error: 'synthetic_thumbnail_failure'}});
    }
    return route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL});
  });
  await page.goto('/');
  await waitForGallery(page);
  const diagnostics = await diagnosticsApi(page);
  await diagnostics.start();
  releaseThumbnails();
  await expect(page.locator('.card[data-id="synthetic-private-00000"] img')).toHaveClass(/loaded/);
  await expect(page.locator('.card[data-id="synthetic-private-00001"] img')).toHaveClass(/loaded/);

  for (let index = 0; index < 14; index += 1) {
    const before = synthetic.servedThrough;
    await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight}));
    await expect.poll(() => synthetic.servedThrough).toBeGreaterThan(before);
    if (index === 4) await diagnostics.mark();
  }
  await page.evaluate(() => window.scrollTo({top: 0}));
  await page.waitForTimeout(150);
  await diagnostics.stop();
  const report = await diagnostics.report();
  const json = JSON.stringify(report);

  expect(report.thumbnails.fallback_http_202).toBe(2);
  expect(report.thumbnails.mount_lifecycles_with_202).toBe(1);
  expect(report.thumbnails.mount_lifecycles_recovered).toBe(1);
  expect(report.thumbnails.mount_lifecycles_failed).toBeGreaterThanOrEqual(1);
  expect(report.thumbnails.fallback_attempts).toBeGreaterThanOrEqual(4);
  expect(report.thumbnails.card_mounts).toBeGreaterThan(report.thumbnails.first_visible_entries);
  expect(report.thumbnails.ready_on_first_visibility).toBeGreaterThan(0);
  expect(report.manual_slowdown_markers).toHaveLength(1);
  expect(report.intervals.some(interval => (
    interval.interval_start_ms <= report.manual_slowdown_markers[0].intervalStartMs
    && interval.interval_end_ms > report.manual_slowdown_markers[0].intervalStartMs
  ))).toBe(true);
  expect(report.resources.observed_entries).toBeGreaterThan(300);
  expect(report.intervals.some(interval => interval.interval_start_ms === 0)).toBe(true);
  expect(report.important_event_tail.some(event => event.type === 'slow_thumbnail_resource')).toBe(true);
  expect(json).not.toContain('synthetic-private');
  expect(json).not.toContain('secret-root');
  expect(json).not.toContain('private-tag');
  expect(json).not.toContain('private-name');
  expect(json).not.toContain('/api/');
});

test('hidden document pauses frame proxy and unsupported Resource Timing remains explicit', async ({page}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'PerformanceObserver', {value: undefined, configurable: true});
  });
  await page.goto('/');
  await waitForGallery(page);
  const diagnostics = await diagnosticsApi(page);
  await diagnostics.start();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {value: 'hidden', configurable: true});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  for (let index = 0; index < 30; index += 1) {
    await page.evaluate(step => new Promise<void>(resolve => requestAnimationFrame(() => {
      window.scrollBy({top: step % 2 ? 160 : -120});
      resolve();
    })), index);
  }
  await diagnostics.stop();
  const report = await diagnostics.report();
  expect(report.frame_intervals.distribution.count).toBe(0);
  expect(report.resources.observer_support).toBe('UNSUPPORTED');
  expect(report.resources.coverage).toBe('UNSUPPORTED');
  expect(report.resources.size_fields_support).toBe('UNSUPPORTED');
});

type OverheadRun = {
  mode: 'off' | 'recording';
  durationMs: number;
  frameP95Ms: number;
  cards: number;
  domNodes: number;
  diagnosticStatusRequests: number;
  pageRequests: number;
  thumbnailRequests: number;
  reportBytes: number;
};

function percentile(values: number[], fraction: number): number {
  const ordered = values.slice().sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] || 0;
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

async function runOverheadPass(
  page: Page,
  mode: 'off' | 'recording',
  diagnosticStatusRequests: () => number,
  requestCounts: () => {pageRequests: number; thumbnailRequests: number},
): Promise<OverheadRun> {
  await page.goto('/');
  await waitForGallery(page);
  const diagnostics = await diagnosticsApi(page);
  const statusBefore = diagnosticStatusRequests();
  const requestsBefore = requestCounts();
  if (mode === 'recording') await diagnostics.start();
  const metrics = await page.evaluate(async () => {
    const frameIntervals: number[] = [];
    const startedAt = performance.now();
    let previous = startedAt;
    for (let step = 0; step < 120; step += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(now => {
        frameIntervals.push(now - previous);
        previous = now;
        const height = Math.max(1, document.documentElement.scrollHeight - innerHeight);
        window.scrollTo({top: Math.min(height, (step + 1) * 260)});
        resolve();
      }));
    }
    return {
      durationMs: performance.now() - startedAt,
      frameIntervals,
      cards: document.querySelectorAll('.card[data-id]').length,
      domNodes: document.querySelectorAll('*').length,
    };
  });
  if (mode === 'recording') await diagnostics.stop();
  const statusAfter = diagnosticStatusRequests();
  const requestsAfter = requestCounts();
  const reportJson = mode === 'recording' ? await diagnostics.reportJson() : null;
  return {
    mode,
    durationMs: metrics.durationMs,
    frameP95Ms: percentile(metrics.frameIntervals, 0.95),
    cards: metrics.cards,
    domNodes: metrics.domNodes,
    diagnosticStatusRequests: statusAfter - statusBefore,
    pageRequests: requestsAfter.pageRequests - requestsBefore.pageRequests,
    thumbnailRequests: requestsAfter.thumbnailRequests - requestsBefore.thumbnailRequests,
    reportBytes: reportJson?.length || 0,
  };
}

test('diagnostic overhead stays bounded across alternating controlled scroll runs', async ({page}, testInfo: TestInfo) => {
  test.setTimeout(120_000);
  const synthetic = await installSyntheticMetadata(page);
  let thumbnailRequests = 0;
  await page.route('**/thumb-file/**', route => {
    thumbnailRequests += 1;
    return route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL});
  });
  await page.route('**/thumb/**', route => {
    thumbnailRequests += 1;
    return route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL});
  });
  let diagnosticStatusRequests = 0;
  await page.route('**/api/status', route => {
    if (route.request().headers()['x-vilra-diagnostics'] === 'long-scroll') {
      diagnosticStatusRequests += 1;
    }
    return route.continue();
  });

  const runs: OverheadRun[] = [];
  for (const mode of ['off', 'recording', 'recording', 'off', 'off', 'recording'] as const) {
    runs.push(await runOverheadPass(
      page,
      mode,
      () => diagnosticStatusRequests,
      () => ({pageRequests: synthetic.pageRequests, thumbnailRequests}),
    ));
  }
  const off = runs.filter(run => run.mode === 'off');
  const recording = runs.filter(run => run.mode === 'recording');
  const summary = {
    runs,
    off: {
      durationMedianMs: median(off.map(run => run.durationMs)),
      frameP95MedianMs: median(off.map(run => run.frameP95Ms)),
      pageRequestsMedian: median(off.map(run => run.pageRequests)),
      thumbnailRequestsMedian: median(off.map(run => run.thumbnailRequests)),
    },
    recording: {
      durationMedianMs: median(recording.map(run => run.durationMs)),
      frameP95MedianMs: median(recording.map(run => run.frameP95Ms)),
      pageRequestsMedian: median(recording.map(run => run.pageRequests)),
      thumbnailRequestsMedian: median(recording.map(run => run.thumbnailRequests)),
      reportBytesMedian: median(recording.map(run => run.reportBytes)),
      diagnosticStatusRequestsMedian: median(recording.map(run => run.diagnosticStatusRequests)),
    },
  };
  await testInfo.attach('gallery-diagnostics-overhead.json', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(summary, null, 2)),
  });
  const artifactDir = process.env.VILRA_DIAGNOSTICS_ARTIFACT_DIR
    || path.resolve(__dirname, '..', '.run', 'benchmarks', 'long-scroll-diagnostics-20261003');
  fs.mkdirSync(artifactDir, {recursive: true});
  fs.writeFileSync(
    path.join(artifactDir, 'overhead.json'),
    JSON.stringify(summary, null, 2),
  );
  const sampleJson = await page.evaluate(() => window.__vilraGalleryDiagnostics?.reportJson() || '');
  fs.writeFileSync(path.join(artifactDir, 'diagnostic-sample.json'), sampleJson);
  console.log('DIAGNOSTIC_OVERHEAD ' + JSON.stringify(summary));

  expect(Math.max(...runs.map(run => run.domNodes))).toBeLessThan(4_000);
  expect(Math.max(...recording.map(run => run.reportBytes))).toBeLessThan(1_000_000);
  expect(Math.max(...recording.map(run => run.diagnosticStatusRequests))).toBeLessThanOrEqual(2);
  expect(summary.recording.durationMedianMs).toBeLessThan(summary.off.durationMedianMs * 1.5 + 500);
  expect(summary.recording.frameP95MedianMs).toBeLessThan(Math.max(100, summary.off.frameP95MedianMs * 2));
});

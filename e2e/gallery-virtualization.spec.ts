import {expect, test, type Page} from '@playwright/test';

const TOTAL_IMAGES = 5_040;
const PAGE_SIZE = 48;
const DOM_CARD_LIMIT = 350;
const THUMBNAIL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

type SyntheticState = {
  servedThrough: number;
  activeRequests: number;
  maxConcurrentRequests: number;
  cursors: string[];
};

function syntheticImage(index: number) {
  const width = 640 + (index % 7) * 120;
  const height = 480 + (index % 11) * 90;
  return {
    id: `synthetic-${String(index).padStart(5, '0')}`,
    path: `synthetic/image-${String(index).padStart(5, '0')}.jpg`,
    thumb_url: `/thumb-file/synthetic-${String(index).padStart(5, '0')}.jpg`,
    width,
    height,
    size: 10_000 + index,
    mtime: TOTAL_IMAGES - index,
    tags: [],
    auto_tags: [],
    folder_tags: [],
    user_tags: [],
  };
}

async function installSyntheticGallery(page: Page): Promise<SyntheticState> {
  const state: SyntheticState = {
    servedThrough: 0,
    activeRequests: 0,
    maxConcurrentRequests: 0,
    cursors: [],
  };
  await page.route('**/api/events', route => route.abort());
  await page.route('**/api/images?**', async route => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get('cursor') || '0';
    const offset = Math.max(0, Number(cursor) || 0);
    const limit = Math.min(PAGE_SIZE, Math.max(1, Number(url.searchParams.get('limit')) || PAGE_SIZE));
    const end = Math.min(TOTAL_IMAGES, offset + limit);
    state.activeRequests += 1;
    state.maxConcurrentRequests = Math.max(state.maxConcurrentRequests, state.activeRequests);
    state.cursors.push(cursor);
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: Array.from({length: end - offset}, (_, itemIndex) => syntheticImage(offset + itemIndex)),
          page: {
            total: url.searchParams.get('include_total') === '1' ? TOTAL_IMAGES : null,
            next_cursor: end < TOTAL_IMAGES ? String(end) : null,
            has_more: end < TOTAL_IMAGES,
          },
        }),
      });
      state.servedThrough = Math.max(state.servedThrough, end);
    } finally {
      state.activeRequests -= 1;
    }
  });
  await page.route('**/thumb-file/**', route => route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL}));
  await page.route('**/thumb/**', route => route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL}));
  await page.route('**/file/synthetic-*', route => route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL}));
  return state;
}

async function gallerySnapshot(page: Page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('.card[data-id]')];
    const slots = [...document.querySelectorAll<HTMLElement>('.virtual-card-slot[data-index]')];
    return {
      scrollY: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      galleryHeight: document.querySelector<HTMLElement>('#gallery')?.getBoundingClientRect().height || 0,
      cards: cards.length,
      domNodes: document.querySelectorAll('*').length,
      ids: cards.map(card => String(card.dataset.id || '')),
      lanes: [...new Set(slots.map(slot => String(slot.dataset.lane || '')))].length,
    };
  });
}

async function assertVirtualGeometry(page: Page): Promise<number> {
  return page.locator('.virtual-card-slot[data-index]').evaluateAll(slots => {
    const gallery = document.querySelector<HTMLElement>('#gallery');
    if (!gallery) throw new Error('gallery missing');
    const galleryRect = gallery.getBoundingClientRect();
    const byLane = new Map<string, Array<{top: number; bottom: number}>>();
    let maxDrift = 0;
    for (const element of slots) {
      const slot = element as HTMLElement;
      const rect = slot.getBoundingClientRect();
      const matrix = new DOMMatrixReadOnly(getComputedStyle(slot).transform);
      const expectedTop = galleryRect.top + matrix.m42;
      const expectedLeft = galleryRect.left + matrix.m41;
      maxDrift = Math.max(maxDrift, Math.abs(rect.top - expectedTop), Math.abs(rect.left - expectedLeft));
      const lane = String(slot.dataset.lane || '0');
      const entries = byLane.get(lane) || [];
      entries.push({top: rect.top, bottom: rect.bottom});
      byLane.set(lane, entries);
    }
    for (const entries of byLane.values()) {
      entries.sort((left, right) => left.top - right.top);
      for (let index = 1; index < entries.length; index += 1) {
        if (entries[index].top < entries[index - 1].bottom - 2) {
          throw new Error(`virtual cards overlap by ${entries[index - 1].bottom - entries[index].top}px`);
        }
      }
    }
    return maxDrift;
  });
}

async function loadAllSyntheticPages(page: Page, state: SyntheticState): Promise<void> {
  for (let iteration = 0; iteration < Math.ceil(TOTAL_IMAGES / PAGE_SIZE) + 8; iteration += 1) {
    if (state.servedThrough >= TOTAL_IMAGES) break;
    const before = state.servedThrough;
    await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight}));
    await expect.poll(() => state.servedThrough, {timeout: 5_000}).toBeGreaterThan(before);
  }
  expect(state.servedThrough).toBe(TOTAL_IMAGES);
}

test('TanStack virtual masonry stays bounded through pagination, reverse scroll, and resize', async ({page}, testInfo) => {
  test.setTimeout(180_000);
  const state = await installSyntheticGallery(page);
  await page.setViewportSize({width: 1366, height: 768});
  await page.goto('/');
  await page.locator('html').evaluate(element => { element.style.scrollBehavior = 'auto'; });
  await expect(page.locator('#gallery-screen')).toBeVisible();
  await expect(page.locator('.card[data-id]').first()).toBeVisible();
  await expect(page.locator('#count-text')).toContainText(String(TOTAL_IMAGES));

  const initial = await gallerySnapshot(page);
  expect(initial.cards).toBeLessThanOrEqual(DOM_CARD_LIMIT);
  expect(initial.ids).toContain('synthetic-00000');
  const initialLane = await page.locator('.virtual-card-slot[data-id="synthetic-00000"]').getAttribute('data-lane');

  await loadAllSyntheticPages(page, state);
  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight}));
  await page.waitForTimeout(200);
  const deepest = await gallerySnapshot(page);
  const deepIds = deepest.ids.slice();
  expect(deepest.cards).toBeLessThanOrEqual(DOM_CARD_LIMIT);
  expect(deepest.domNodes).toBeLessThan(4_000);
  expect(new Set(deepest.ids).size).toBe(deepest.ids.length);
  expect(deepIds.some(id => id.startsWith('synthetic-05'))).toBeTruthy();
  const deepGeometryDrift = await assertVirtualGeometry(page);
  expect(deepGeometryDrift).toBeLessThan(2);

  await page.evaluate(() => window.scrollTo({top: 0}));
  await expect(page.locator('.card[data-id="synthetic-00000"]')).toBeVisible();
  const returned = await gallerySnapshot(page);
  expect(returned.cards).toBeLessThanOrEqual(DOM_CARD_LIMIT);
  expect(returned.domNodes).toBeLessThan(4_000);
  expect(returned.ids.some(id => deepIds.includes(id))).toBeFalsy();
  expect(await page.locator('.virtual-card-slot[data-id="synthetic-00000"]').getAttribute('data-lane')).toBe(initialLane);

  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight}));
  await page.waitForTimeout(150);
  await page.evaluate(() => window.scrollTo({top: 0}));
  await expect(page.locator('.card[data-id="synthetic-00000"]')).toBeVisible();
  const reversed = await gallerySnapshot(page);
  expect(new Set(reversed.ids).size).toBe(reversed.ids.length);
  expect(reversed.cards).toBeLessThanOrEqual(DOM_CARD_LIMIT);

  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight * 0.6}));
  await page.waitForTimeout(150);
  const beforeResize = await gallerySnapshot(page);
  await page.setViewportSize({width: 980, height: 768});
  await page.waitForTimeout(250);
  const afterResize = await gallerySnapshot(page);
  expect(afterResize.scrollY).toBeGreaterThan(500);
  expect(afterResize.cards).toBeLessThanOrEqual(DOM_CARD_LIMIT);
  expect(new Set(afterResize.ids).size).toBe(afterResize.ids.length);
  expect(afterResize.lanes).not.toBe(beforeResize.lanes);
  expect(await assertVirtualGeometry(page)).toBeLessThan(2);
  expect(state.maxConcurrentRequests).toBe(1);
  expect(new Set(state.cursors).size).toBe(state.cursors.length);

  await testInfo.attach('virtualization-snapshots.json', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({initial, deepest, returned, reversed, beforeResize, afterResize, deepGeometryDrift}, null, 2)),
  });
});

import {expect, test, type Page} from '@playwright/test';

const THUMBNAIL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function syntheticImage(index: number) {
  const id = `admission-${String(index).padStart(4, '0')}`;
  return {
    id,
    path: `admission/image-${String(index).padStart(4, '0')}.jpg`,
    thumb_url: `/thumb-file/${id}.jpg`,
    width: 640 + (index % 5) * 80,
    height: 480 + (index % 7) * 60,
    size: 10_000 + index,
    mtime: 10_000 - index,
    tags: [],
    auto_tags: [],
    folder_tags: [],
    user_tags: [],
  };
}

async function installSyntheticGallery(page: Page, count = 360): Promise<void> {
  await page.route('**/api/events', route => route.abort());
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const payload = await response.json();
    return route.fulfill({response, json: {
      ...payload,
      tabs: [],
      active_tab_id: null,
      last_image_id: null,
      scroll_top: 0,
    }});
  });
  await page.route('**/api/images?**', route => route.fulfill({json: {
    items: Array.from({length: count}, (_, index) => syntheticImage(index)),
    page: {total: count, next_cursor: null, has_more: false},
  }}));
}

async function currentVisibleCardIds(page: Page): Promise<string[]> {
  return page.locator('.card[data-id]').evaluateAll(cards => cards
    .filter(card => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    })
    .map(card => String((card as HTMLElement).dataset.id || ''))
    .filter(Boolean));
}

test('visible admissions finish before directional near admissions', async ({page}) => {
  await installSyntheticGallery(page, 120);
  const admissions: Array<{id: string; priorityClass: string | null}> = [];
  await page.route('**/thumb-file/**', route => route.fulfill({status: 404, json: {detail: 'Not found'}}));
  await page.route('**/thumb/**', route => {
    const url = new URL(route.request().url());
    admissions.push({
      id: url.pathname.split('/').pop() || '',
      priorityClass: url.searchParams.get('class'),
    });
    if (url.searchParams.get('class') === 'visible') {
      return route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL});
    }
    return route.fulfill({status: 202, json: {retry_after_ms: 300}});
  });

  await page.goto('/');
  await expect(page.locator('.card[data-id]').first()).toBeVisible();
  await expect.poll(() => admissions.some(item => item.priorityClass === 'near')).toBe(true);
  const firstNear = admissions.findIndex(item => item.priorityClass === 'near');
  expect(firstNear).toBeGreaterThan(0);
  expect(admissions.slice(0, firstNear).every(item => item.priorityClass === 'visible')).toBe(true);
  expect(admissions.every(item => item.priorityClass === 'visible' || item.priorityClass === 'near')).toBe(true);
});

test('one 202 admission owns one bounded cache polling loop', async ({page}) => {
  await installSyntheticGallery(page, 120);
  const targetId = 'admission-0000';
  let admissionRequests = 0;
  let targetCacheRequests = 0;
  let activePolls = 0;
  let maxActivePolls = 0;
  await page.route('**/thumb-file/**', async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop()?.replace('.jpg', '');
    if (id !== targetId) {
      return route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL});
    }
    targetCacheRequests += 1;
    if (targetCacheRequests === 1) return route.fulfill({status: 404, json: {detail: 'Not found'}});
    activePolls += 1;
    maxActivePolls = Math.max(maxActivePolls, activePolls);
    await new Promise(resolve => setTimeout(resolve, 40));
    activePolls -= 1;
    if (targetCacheRequests < 3) return route.fulfill({status: 404, json: {detail: 'Not found'}});
    return route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL});
  });
  await page.route(`**/thumb/${targetId}*`, route => {
    admissionRequests += 1;
    expect(new URL(route.request().url()).searchParams.get('class')).toBe('visible');
    return route.fulfill({status: 202, json: {retry_after_ms: 10}});
  });

  await page.goto('/');
  const image = page.locator(`.card[data-id="${targetId}"] img`);
  await expect(image).toHaveClass(/loaded/);
  expect(admissionRequests).toBe(1);
  expect(targetCacheRequests).toBeGreaterThanOrEqual(3);
  expect(maxActivePolls).toBe(1);
  await page.waitForTimeout(400);
  expect(admissionRequests).toBe(1);
});

test('fast scroll skips transient missing cards and settle admits the current viewport', async ({page}) => {
  await installSyntheticGallery(page);
  const admissions: Array<{id: string; priorityClass: string | null}> = [];
  const missingPrimaryIds = new Set<string>();
  await page.route('**/thumb-file/**', route => {
    const id = new URL(route.request().url()).pathname.split('/').pop()?.replace('.jpg', '') || '';
    const index = Number(id.split('-').pop());
    if (index < 20) return route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL});
    missingPrimaryIds.add(id);
    return route.fulfill({status: 404, json: {detail: 'Not found'}});
  });
  await page.route('**/thumb/**', route => {
    const url = new URL(route.request().url());
    admissions.push({
      id: url.pathname.split('/').pop() || '',
      priorityClass: url.searchParams.get('class'),
    });
    return route.fulfill({status: 202, json: {retry_after_ms: 300}});
  });

  await page.goto('/');
  await expect(page.locator('.card[data-id="admission-0000"] img')).toHaveClass(/loaded/);
  await page.waitForTimeout(250);
  const admittedBeforeFastScroll = new Set(admissions.map(item => item.id));
  const mountedDuringFastScroll = new Set<string>();
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, 2_500);
    await page.waitForTimeout(20);
    const mounted = await page.locator('.card[data-id]').evaluateAll(cards => (
      cards.map(card => String((card as HTMLElement).dataset.id || '')).filter(Boolean)
    ));
    mounted.forEach(id => mountedDuringFastScroll.add(id));
  }
  await page.waitForTimeout(80);
  const admissionsBeforeSettle = admissions.length;
  const visibleAfterScroll = await currentVisibleCardIds(page);
  await expect.poll(() => visibleAfterScroll.filter(id => (
    missingPrimaryIds.has(id)
    && !admittedBeforeFastScroll.has(id)
    && !admissions.some(item => item.id === id && item.priorityClass === 'visible')
  )), {message: `visible ids: ${visibleAfterScroll.join(',')}`}).toEqual([]);

  const admittedIds = new Set(admissions.map(item => item.id));
  const transientMissing = [...mountedDuringFastScroll].filter(id => (
    Number(id.split('-').pop()) >= 20 && !visibleAfterScroll.includes(id)
  ));
  expect(
    transientMissing.length,
    `mounted=${[...mountedDuringFastScroll].join(',')} visible=${visibleAfterScroll.join(',')}`,
  ).toBeGreaterThan(0);
  expect(transientMissing.some(id => !admittedIds.has(id))).toBe(true);
  expect(admissionsBeforeSettle).toBeLessThan(transientMissing.length + visibleAfterScroll.length);
});

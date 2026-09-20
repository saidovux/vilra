import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

type ImageItem = {
  id: string;
  path: string;
  thumb_url?: string;
  width?: number;
  auto_tags?: string[];
  user_tags?: string[];
};

type TagItem = {
  name: string;
  image_count: number;
  auto_count: number;
  user_count: number;
  source: 'auto' | 'user';
  sources: Array<'auto' | 'user'>;
};

type ProblemApiItem = {
  id: number;
  image_id: string | null;
  root_path: string;
  path: string;
  absolute_path: string;
  file_name: string;
  severity: 'error' | 'warning';
  kind: string;
  expected_format: string | null;
  detected_format: string | null;
  size: number;
  mtime_ns: number;
  technical_detail: string | null;
  created_at: string;
  updated_at: string;
};

const fatalMessages = [
  /Uncaught/i,
  /Unhandled/i,
  /openLightboxById: image not found in current gallery state/i,
];

function fixtureRoot(): string {
  const state = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '.run', 'e2e-state.json'), 'utf8'),
  ) as {fixtureDir: string};
  return state.fixtureDir;
}

function problemFixture(id: number, severity: 'error' | 'warning' = 'error', name = `problem-${id}.jpg`): ProblemApiItem {
  return {
    id,
    image_id: `problem-image-${id}`,
    root_path: fixtureRoot(),
    path: name,
    absolute_path: path.join(fixtureRoot(), name),
    file_name: name,
    severity,
    kind: severity === 'warning' ? 'format_mismatch' : 'decode_error',
    expected_format: 'jpeg',
    detected_format: severity === 'warning' ? 'png' : null,
    size: 100,
    mtime_ns: 1,
    technical_detail: 'fixture',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

async function openProblems(page: Page): Promise<void> {
  const sidebar = page.locator('#folder-sidebar');
  if (await sidebar.evaluate(element => element.classList.contains('collapsed'))) {
    await page.locator('#folder-sidebar-toggle').click();
  }
  await page.locator('#problems-nav').click();
  await expect(page.locator('#problems-wrap')).toBeVisible();
}

async function visibleCards(page: Page) {
  const cards = page.locator('.card[data-id]');
  await expect(cards.first()).toBeVisible({ timeout: 60_000 });
  return cards;
}

async function waitForGallery(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#gallery-screen')).toBeVisible({ timeout: 60_000 });
  await closePreviewIfOpen(page);
  await visibleCards(page);
}

async function imageItems(page: Page, limit = 120): Promise<ImageItem[]> {
  const response = await page.request.get(`/api/images?limit=${limit}&include_total=1`);
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(Array.isArray(data.items)).toBeTruthy();
  return data.items;
}

async function tagItems(page: Page): Promise<TagItem[]> {
  const response = await page.request.get('/api/tags');
  expect(response.ok()).toBeTruthy();
  const data = await response.json();
  expect(Array.isArray(data.tags)).toBeTruthy();
  return data.tags;
}

async function clickCardAndExpectPreview(page: Page, cardIndex: number): Promise<string> {
  const cards = await visibleCards(page);
  const card = cards.nth(cardIndex);
  await expect(card).toBeVisible();
  const imageId = await card.getAttribute('data-id');
  expect(imageId).toBeTruthy();

  const fileResponse = page.waitForResponse(response =>
    response.url().includes(`/file/${imageId}`) && response.status() === 200,
  );
  await card.click();
  await fileResponse;
  await expect(page.locator('#preview-modal')).toBeVisible();
  await expect(page.locator('#preview-open')).toHaveAttribute('href', `/file/${imageId}`);
  return imageId || '';
}

async function closePreview(page: Page): Promise<void> {
  await page.locator('#preview-close').click();
  await expect(page.locator('#preview-modal')).not.toBeVisible();
  await page.waitForTimeout(400);
}

async function closePreviewIfOpen(page: Page): Promise<void> {
  const modal = page.locator('#preview-modal');
  if (await modal.isVisible().catch(() => false)) {
    await page.locator('#preview-close').click();
    await expect(modal).not.toBeVisible();
    await page.waitForTimeout(400);
  }
}

test.beforeEach(async ({ page }) => {
  const consoleMessages: string[] = [];
  page.on('console', message => {
    consoleMessages.push(message.text());
  });
  page.on('pageerror', error => {
    consoleMessages.push(error.message);
  });
  await page.exposeFunction('__tagimageConsoleMessages', () => consoleMessages);
  await page.request.patch('/api/session', {
    data: {
      last_image_id: null,
      tabs: [],
      active_tab_id: null,
      folder_tag_sync: true,
    },
  }).catch(() => undefined);
});

test.afterEach(async ({ page }) => {
  const messages = await page.evaluate(async () => {
    const fn = (window as unknown as { __tagimageConsoleMessages?: () => string[] }).__tagimageConsoleMessages;
    return fn ? await fn() : [];
  });
  expect(messages.filter(message => fatalMessages.some(pattern => pattern.test(message)))).toEqual([]);
});

test('gallery card opens original image through stable file id', async ({ page }) => {
  await waitForGallery(page);
  const imageId = await clickCardAndExpectPreview(page, 0);

  const original = await page.request.get(`/file/${imageId}`);
  expect(original.status()).toBe(200);
  expect(original.headers()['content-type']).toMatch(/^image\//);

  await closePreview(page);
});

test('lower batch cards stay openable after pagination', async ({ page }) => {
  await waitForGallery(page);
  await expect(page.locator('.card[data-id]')).toHaveCount(48);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator('.card[data-id]').nth(55)).toBeVisible({ timeout: 30_000 });

  const lowerCard = page.locator('.card[data-id]').nth(55);
  const imageId = await lowerCard.getAttribute('data-id');
  expect(imageId).toBeTruthy();

  await expect(page.locator(`.card[data-id="${imageId}"]`)).toBeVisible();

  await clickCardAndExpectPreview(page, 55);
  await closePreview(page);

  const items = await imageItems(page);
  expect(items.some(item => item.id === imageId)).toBeTruthy();
});

test('live filesystem create rename move modify and delete need no refresh', async ({ page }) => {
  await waitForGallery(page);
  const root = fixtureRoot();
  const sourceA = path.join(root, 'batch-a', 'fixture-001.png');
  const sourceB = path.join(root, 'batch-a', 'fixture-003.png');
  const created = path.join(root, 'live-created.png');
  const renamed = path.join(root, 'live-renamed.png');
  const newDir = path.join(root, 'live-directory');
  const moved = path.join(newDir, 'live-moved.png');

  for (const candidate of [created, renamed, moved]) fs.rmSync(candidate, {force: true});
  fs.rmSync(newDir, {recursive: true, force: true});

  try {
    fs.copyFileSync(sourceA, created);
    const createdCard = page.locator('.card[data-id]').filter({hasText: 'live-created.png'});
    await expect(createdCard).toBeVisible({timeout: 15_000});
    const imageId = await createdCard.getAttribute('data-id');
    expect(imageId).toBeTruthy();

    fs.renameSync(created, renamed);
    await expect(page.locator('.card[data-id]').filter({hasText: 'live-created.png'})).toHaveCount(0);
    const renamedCard = page.locator('.card[data-id]').filter({hasText: 'live-renamed.png'});
    await expect(renamedCard).toBeVisible({timeout: 15_000});
    await expect(renamedCard).toHaveAttribute('data-id', imageId || '');

    fs.mkdirSync(newDir);
    await page.waitForTimeout(400);
    fs.renameSync(renamed, moved);
    const movedCard = page.locator('.card[data-id]').filter({hasText: 'live-moved.png'});
    await expect(movedCard).toBeVisible({timeout: 15_000});
    await expect(movedCard).toHaveAttribute('data-id', imageId || '');

    let previousThumb = '';
    await expect.poll(async () => {
      const response = await page.request.get(`/thumb/${imageId}`);
      if (response.status() !== 200) return '';
      previousThumb = (await response.body()).toString('base64');
      return previousThumb;
    }, {timeout: 15_000}).not.toBe('');

    const before = await imageItems(page);
    const oldWidth = before.find(item => item.id === imageId)?.width;
    fs.copyFileSync(sourceB, moved);
    await expect.poll(async () => {
      const items = await imageItems(page);
      return items.find(item => item.id === imageId)?.width;
    }, {timeout: 15_000}).not.toBe(oldWidth);
    await expect.poll(async () => {
      const response = await page.request.get(`/thumb/${imageId}`);
      if (response.status() !== 200) return false;
      return (await response.body()).toString('base64') !== previousThumb;
    }, {timeout: 15_000}).toBe(true);

    fs.rmSync(moved, { force: true });
    await expect(movedCard).toHaveCount(0, {timeout: 15_000});
  } finally {
    for (const candidate of [created, renamed, moved]) fs.rmSync(candidate, {force: true});
    fs.rmSync(newDir, {recursive: true, force: true});
    await expect.poll(async () => {
      const items = await imageItems(page);
      return items.some(item => item.path.startsWith('live-'));
    }, {timeout: 15_000}).toBe(false);
  }
});

test('delete and recreate at the same path restores the card and total', async ({ page }) => {
  await waitForGallery(page);
  const root = fixtureRoot();
  const source = path.join(root, 'batch-a', 'fixture-001.png');
  const restoredPath = path.join(root, 'restored-same-path.png');
  const count = page.locator('#count-text');
  const initialTotal = Number((await count.textContent())?.match(/\d+/)?.[0] || 0);
  const card = page.locator('.card[data-id]').filter({hasText: 'restored-same-path.png'});

  fs.rmSync(restoredPath, {force: true});
  try {
    fs.copyFileSync(source, restoredPath);
    await expect(card).toBeVisible({timeout: 15_000});
    const imageId = await card.getAttribute('data-id');
    expect(imageId).toBeTruthy();
    await expect.poll(async () => Number((await count.textContent())?.match(/\d+/)?.[0] || 0))
      .toBe(initialTotal + 1);

    fs.rmSync(restoredPath, {force: true});
    await expect(card).toHaveCount(0, {timeout: 15_000});
    await expect.poll(async () => Number((await count.textContent())?.match(/\d+/)?.[0] || 0))
      .toBe(initialTotal);

    fs.copyFileSync(source, restoredPath);
    await expect(card).toBeVisible({timeout: 15_000});
    await expect(card).toHaveAttribute('data-id', imageId || '');
    await expect.poll(async () => Number((await count.textContent())?.match(/\d+/)?.[0] || 0))
      .toBe(initialTotal + 1);
    const items = await imageItems(page);
    expect(items.some(item => item.id === imageId && item.path === 'restored-same-path.png')).toBeTruthy();
  } finally {
    fs.rmSync(restoredPath, {force: true});
  }
});

test('/file id API returns originals and cleanly rejects unknown ids', async ({ page }) => {
  const image = (await imageItems(page, 20)).find(item => item.path.startsWith('batch-'));
  expect(image?.id).toBeTruthy();

  const valid = await page.request.get(`/file/${image?.id}`);
  expect(valid.status()).toBe(200);
  expect(valid.headers()['content-type']).toMatch(/^image\//);

  const invalid = await page.request.get('/file/not-a-real-image-id');
  expect(invalid.ok()).toBeFalsy();
});

test('original opening is independent from thumbnail state', async ({ page }) => {
  await waitForGallery(page);
  const first = page.locator('.card[data-id]').first();
  const imageId = await first.getAttribute('data-id');
  expect(imageId).toBeTruthy();

  const thumbUrl = await first.locator('img').getAttribute('src');
  expect(thumbUrl === null || thumbUrl.includes('/thumb')).toBeTruthy();

  await clickCardAndExpectPreview(page, 0);
  await expect(page.locator('#preview-open')).toHaveAttribute('href', `/file/${imageId}`);
  await closePreview(page);
});

test('sidebar exposes folder tags above physical libraries and filters by multiple tags', async ({ page }) => {
  await waitForGallery(page);
  await page.locator('#folder-sidebar-toggle').click();
  await expect(page.locator('#folder-sidebar')).not.toHaveClass(/collapsed/);

  const autoGroup = page.locator('.sidebar-tags-section');
  const libraryGroup = page.locator('.sidebar-library-section');
  const autoBox = await autoGroup.boundingBox();
  const libraryBox = await libraryGroup.boundingBox();
  expect(autoBox?.y).toBeLessThan(libraryBox?.y || 0);

  const batchA = page.locator('[data-sidebar-tag="batch-a"]');
  await expect(batchA).toBeVisible();
  await expect(batchA.locator('.auto-label')).toHaveText('AUTO');
  await expect(batchA.locator('.sidebar-tag-count')).toHaveText('36');
  await expect(page.locator('.library-root')).toHaveCount(1);
  await expect(page.locator('.library-root-path')).toContainText(fixtureRoot());

  await batchA.click();
  await expect(batchA).toHaveClass(/selected/);
  await expect.poll(async () => Number((await page.locator('#count-text').textContent())?.match(/\d+/)?.[0] || 0))
    .toBe(36);
  const paths = await page.locator('.card-name').allTextContents();
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every(value => value.includes('fixture-'))).toBeTruthy();

  await batchA.click();
  await expect(batchA).not.toHaveClass(/selected/);
});

test('folder tag setting pauses sync and destructive cleanup preserves user tags', async ({ page }) => {
  await waitForGallery(page);
  const root = fixtureRoot();
  const source = path.join(root, 'batch-a', 'fixture-001.png');
  const newDir = path.join(root, 'sync-off');
  const newImage = path.join(newDir, 'inside.png');
  const keepTag = 'E2E Keep';
  fs.rmSync(newDir, {recursive: true, force: true});

  const [target] = await imageItems(page, 10);
  expect(target?.id).toBeTruthy();
  await page.request.post('/api/tags', {data: {name: keepTag}});
  await page.request.post(`/api/tag/${target.id}`, {data: {tags: [keepTag]}});

  try {
    await page.locator('#settings-toggle').click();
    await page.locator('[data-settings-tab="tags"]').click();
    const toggle = page.locator('#folder-tag-sync-toggle');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect.poll(async () => {
      const session = await (await page.request.get('/api/session')).json();
      return session.folder_tag_sync;
    }).toBe(false);

    fs.mkdirSync(newDir);
    fs.copyFileSync(source, newImage);
    await expect.poll(async () => {
      const items = await imageItems(page);
      return items.find(item => item.path === 'sync-off/inside.png')?.auto_tags || null;
    }, {timeout: 15_000}).toEqual([]);
    expect((await tagItems(page)).some(tag => tag.name === 'batch-a' && tag.auto_count > 0)).toBeTruthy();

    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-action="delete-all-auto-tags"]').click();
    await expect.poll(async () => (await tagItems(page)).every(tag => tag.auto_count === 0))
      .toBe(true);
    const afterCleanup = await imageItems(page);
    expect(afterCleanup.find(item => item.id === target.id)?.user_tags).toContain(keepTag);
    expect((await tagItems(page)).some(tag => tag.name === keepTag && tag.user_count === 1)).toBeTruthy();

    await toggle.check();
    await expect.poll(async () => {
      const session = await (await page.request.get('/api/session')).json();
      return session.folder_tag_sync;
    }).toBe(true);
    await expect.poll(async () => {
      const items = await imageItems(page);
      return items.find(item => item.path === 'sync-off/inside.png')?.auto_tags || [];
    }, {timeout: 20_000}).toContain('sync-off');
    await expect.poll(async () => (await tagItems(page)).some(tag => tag.source === 'auto' && tag.sources.includes('auto')))
      .toBe(true);
  } finally {
    await page.request.patch('/api/session', {data: {folder_tag_sync: true}}).catch(() => undefined);
    await page.request.delete(`/api/tags/${encodeURIComponent(keepTag)}`).catch(() => undefined);
    fs.rmSync(newDir, {recursive: true, force: true});
  }
});

test('Problems view lists live file issues and rechecks one stored path', async ({ page }) => {
  await page.setViewportSize({width: 1366, height: 768});
  const root = fixtureRoot();
  const broken = path.join(root, 'e2e-broken.jpg');
  fs.rmSync(broken, {force: true});
  try {
    fs.writeFileSync(broken, Buffer.from('not a jpeg'));
    await expect.poll(async () => {
      const response = await page.request.get('/api/problems/summary');
      const data = await response.json();
      return Number(data.errors || 0);
    }, {timeout: 15_000}).toBeGreaterThan(0);

    await waitForGallery(page);
    await page.locator('#folder-sidebar-toggle').click();
    await page.locator('#problems-nav').click();
    await expect(page.locator('#problems-wrap')).toBeVisible();
    expect((await page.locator('.problems-head').boundingBox())?.height).toBeLessThan(150);
    const row = page.locator('.problem-row').filter({hasText: 'e2e-broken.jpg'});
    await expect(row).toBeVisible({timeout: 15_000});
    await expect(row.locator('.problem-severity')).toContainText('Ошибка');

    await page.locator('#problems-search').fill('E2E-BROKEN');
    await expect(row).toBeVisible();
    await row.locator('[data-action="recheck-problem"]').click();
    await expect(row).toBeVisible();
    fs.rmSync(broken, {force: true});
    await expect(row).toHaveCount(0, {timeout: 15_000});

    await page.locator('#gallery-nav').click();
    await expect(page.locator('#gallery-wrap')).toBeVisible();
  } finally {
    fs.rmSync(broken, {force: true});
  }
});

test('terminal thumbnail 422 removes the card and does not retry', async ({ page }) => {
  let terminalSeen = false;
  let repaired = false;
  let terminalRequests = 0;
  let targetId = '';
  const thumbnail = fs.readFileSync(path.join(fixtureRoot(), 'batch-a', 'fixture-001.png'));

  await page.route('**/api/images?**', async route => {
    const response = await route.fetch();
    const data = await response.json();
    if (terminalSeen && !repaired && Array.isArray(data.items)) {
      data.items = data.items.filter((item: ImageItem) => item.id !== targetId);
      if (data.page && typeof data.page.total === 'number') data.page.total -= 1;
    }
    await route.fulfill({response, json: data});
  });

  await waitForGallery(page);
  const firstCard = page.locator('.card[data-id]').first();
  targetId = String(await firstCard.getAttribute('data-id'));
  expect(targetId).toBeTruthy();
  await page.route(`**/thumb/${targetId}*`, async route => {
    terminalRequests += 1;
    if (repaired) {
      return route.fulfill({status: 200, contentType: 'image/png', body: thumbnail});
    }
    terminalSeen = true;
    await route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({error: 'image_unavailable'}),
    });
  });
  await firstCard.locator('img').evaluate(image => image.dispatchEvent(new Event('error')));

  const card = page.locator(`.card[data-id="${targetId}"]`);
  await expect(card).toHaveCount(0, {timeout: 15_000});
  await page.waitForTimeout(700);
  expect(terminalRequests).toBe(1);

  repaired = true;
  const refreshed = page.waitForResponse(response => response.url().includes('/api/images?'));
  await page.locator('#sort-select').dispatchEvent('change');
  await refreshed;
  const repairedCard = page.locator(`.card[data-id="${targetId}"]`);
  await expect(repairedCard).toBeVisible();
  await repairedCard.locator('img').evaluate(image => image.dispatchEvent(new Event('error')));
  await expect.poll(() => terminalRequests).toBeGreaterThan(1);
  await expect(repairedCard.locator('img')).toHaveClass(/loaded/);
});

test('Problems summary and list failures are independent', async ({ page }) => {
  const issue = problemFixture(101);
  let summaryFails = true;
  let listFails = false;
  await page.route('**/api/problems/summary', route => {
    if (summaryFails) return route.fulfill({status: 500, json: {detail: 'summary unavailable'}});
    return route.fulfill({json: {total: 2, errors: 2, warnings: 0, latest_updated_at: 'changed'}});
  });
  await page.route('**/api/problems?**', route => {
    if (listFails) return route.fulfill({status: 500, json: {detail: 'list unavailable'}});
    return route.fulfill({json: {items: [issue], page: {total: 1, limit: 100, offset: 0, has_more: false}}});
  });

  await waitForGallery(page);
  await openProblems(page);
  await expect(page.locator('.problem-row').filter({hasText: issue.file_name})).toBeVisible();

  summaryFails = false;
  listFails = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('#problems-badge')).toHaveText('2');
  await expect(page.locator('#problems-feedback')).toContainText('list unavailable');
});

test('changed safety-poll summary refreshes an open Problems list', async ({ page }) => {
  const first = problemFixture(111);
  const second = problemFixture(112, 'warning');
  let changed = false;
  let listRequests = 0;
  await page.route('**/api/problems/summary', route => route.fulfill({json: {
    total: changed ? 2 : 1,
    errors: 1,
    warnings: changed ? 1 : 0,
    latest_updated_at: changed ? 'version-b' : 'version-a',
  }}));
  await page.route('**/api/problems?**', route => {
    listRequests += 1;
    const items = changed ? [first, second] : [first];
    return route.fulfill({json: {items, page: {total: items.length, limit: 100, offset: 0, has_more: false}}});
  });

  await waitForGallery(page);
  await openProblems(page);
  await expect(page.locator('.problem-row')).toHaveCount(1);
  const requestsBeforeChange = listRequests;
  changed = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.problem-row')).toHaveCount(2);
  expect(listRequests).toBeGreaterThan(requestsBeforeChange);
});

test('Problems refresh does not restore a preview closed by view navigation', async ({ page }) => {
  await waitForGallery(page);
  await clickCardAndExpectPreview(page, 0);
  await page.evaluate(() => (document.querySelector('#problems-nav') as HTMLElement).click());
  await expect(page.locator('#problems-wrap')).toBeVisible();
  await expect(page.locator('#preview-modal')).not.toBeVisible();

  const refreshed = page.waitForResponse(response => response.url().includes('/api/images?'));
  await page.locator('#sort-select').selectOption('path_asc', {force: true});
  await refreshed;
  await expect(page.locator('#preview-modal')).not.toBeVisible();

  await page.evaluate(() => (document.querySelector('#gallery-nav') as HTMLElement).click());
  await expect(page.locator('#gallery-wrap')).toBeVisible();
  await expect(page.locator('#sort-select')).toHaveValue('path_asc');
  await expect(page.locator('#preview-modal')).not.toBeVisible();
});

test('format mismatch is a warning, stays in gallery, and does not increment error badge', async ({ page }) => {
  await waitForGallery(page);
  const root = fixtureRoot();
  const mismatch = path.join(root, 'warning-content.jpg');
  const source = path.join(root, 'batch-a', 'fixture-001.png');
  fs.rmSync(mismatch, {force: true});
  const before = await (await page.request.get('/api/problems/summary')).json();
  try {
    fs.copyFileSync(source, mismatch);
    await expect(page.locator('.card[data-id]').filter({hasText: 'warning-content.jpg'})).toBeVisible({timeout: 15_000});
    await expect.poll(async () => {
      const summary = await (await page.request.get('/api/problems/summary')).json();
      return Number(summary.warnings || 0);
    }, {timeout: 15_000}).toBeGreaterThan(Number(before.warnings || 0));
    await page.route('**/api/problems/summary', route => route.fulfill({json: {
      total: 3, errors: 2, warnings: 1, latest_updated_at: 'warning-semantics',
    }}));

    await openProblems(page);
    const row = page.locator('.problem-row').filter({hasText: 'warning-content.jpg'});
    await expect(row).toBeVisible();
    await expect(row.locator('.problem-severity')).toContainText('Внимание');
    await expect(page.locator('#problems-badge')).toHaveText('2');
    await page.locator('#gallery-nav').click();
    await expect(page.locator('.card[data-id]').filter({hasText: 'warning-content.jpg'})).toBeVisible();
  } finally {
    fs.rmSync(mismatch, {force: true});
  }
});

test('pending thumbnail 202 retries until a thumbnail is available', async ({ page }) => {
  await waitForGallery(page);
  const card = page.locator('.card[data-id]').first();
  const imageId = String(await card.getAttribute('data-id'));
  const thumbnail = fs.readFileSync(path.join(fixtureRoot(), 'batch-a', 'fixture-001.png'));
  let requests = 0;
  await page.route(`**/thumb/${imageId}*`, route => {
    requests += 1;
    if (requests <= 2) {
      return route.fulfill({status: 202, json: {retry_after_ms: 10}});
    }
    return route.fulfill({status: 200, contentType: 'image/png', body: thumbnail});
  });

  const image = card.locator('img');
  await image.evaluate(element => element.dispatchEvent(new Event('error')));
  await expect.poll(() => requests).toBeGreaterThanOrEqual(3);
  await expect(image).toHaveClass(/loaded/);
});

test('/file 422 closes preview flow without a generic alert and removes the image', async ({ page }) => {
  await waitForGallery(page);
  const card = page.locator('.card[data-id]').first();
  const imageId = String(await card.getAttribute('data-id'));
  let dialogSeen = false;
  page.on('dialog', dialog => {
    dialogSeen = true;
    void dialog.dismiss();
  });
  await page.route(`**/file/${imageId}`, route => route.fulfill({
    status: 422,
    contentType: 'application/json',
    body: JSON.stringify({error: 'image_unavailable'}),
  }));
  await page.route('**/api/images?**', route => route.fulfill({json: {
    items: [],
    page: {total: 0, next_cursor: null, has_more: false},
  }}));

  await card.click();
  await expect(page.locator(`.card[data-id="${imageId}"]`)).toHaveCount(0);
  await expect(page.locator('#preview-modal')).not.toBeVisible();
  expect(dialogSeen).toBe(false);
});

test('single recheck applies warning response before canonical refresh', async ({ page }) => {
  let issue = problemFixture(121);
  let failCanonicalRefresh = false;
  await page.route('**/api/problems/summary', route => route.fulfill({json: {
    total: 1,
    errors: issue.severity === 'error' ? 1 : 0,
    warnings: issue.severity === 'warning' ? 1 : 0,
    latest_updated_at: issue.updated_at,
  }}));
  await page.route('**/api/problems?**', async route => {
    if (failCanonicalRefresh) {
      await route.fulfill({status: 500, json: {error: 'canonical refresh unavailable'}});
      return;
    }
    const severity = new URL(route.request().url()).searchParams.get('severity');
    const items = severity === 'all' || severity === issue.severity ? [issue] : [];
    await route.fulfill({json: {items, page: {total: items.length, limit: 100, offset: 0, has_more: false}}});
  });
  await page.route('**/api/problems/121/recheck', route => {
    issue = {...issue, severity: 'warning', kind: 'format_mismatch', detected_format: 'png', updated_at: 'updated'};
    failCanonicalRefresh = true;
    return route.fulfill({json: {ok: true, status: 'warning', issue}});
  });

  await waitForGallery(page);
  await openProblems(page);
  const row = page.locator('.problem-row').filter({hasText: issue.file_name});
  await expect(row).toBeVisible();
  await row.locator('[data-action="recheck-problem"]').click();
  await expect(row.locator('.problem-severity')).toContainText('Внимание');
  await expect(page.locator('#problems-feedback')).toContainText('canonical refresh unavailable');
  failCanonicalRefresh = false;
  await page.locator('[data-action="set-problems-filter"][data-severity="warning"]').click({force: true});
  await expect(page.locator('.problem-row').filter({hasText: issue.file_name})).toBeVisible();
});

test('recheck-all keeps rows, completes by SSE, and recovers from 409', async ({ page }) => {
  const issue = problemFixture(131);
  let postStatus = 202;
  let releaseSse: (() => void) | null = null;
  const sseGate = new Promise<void>(resolve => { releaseSse = resolve; });
  await page.route('**/api/events*', async route => {
    await sseGate;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'id: 9001\ndata: {"sequence":9001,"type":"problems_recheck_finished","data":{"requested":1,"processed":1,"failed":0}}\n\n',
    });
  });
  await page.route('**/api/problems/summary', route => route.fulfill({json: {
    total: 1, errors: 1, warnings: 0, latest_updated_at: 'same',
  }}));
  await page.route('**/api/problems?**', route => route.fulfill({json: {
    items: [issue], page: {total: 1, limit: 100, offset: 0, has_more: false},
  }}));
  await page.route('**/api/problems/recheck-all', route => route.fulfill({
    status: postStatus,
    json: postStatus === 202 ? {ok: true, scheduled: 1} : {error: 'problems_recheck_already_running'},
  }));

  await waitForGallery(page);
  await openProblems(page);
  const row = page.locator('.problem-row').filter({hasText: issue.file_name});
  const button = page.locator('#problems-recheck-all');
  await expect(row).toBeVisible();
  await button.click();
  await expect(button).toBeDisabled();
  await expect(row).toBeVisible();
  releaseSse?.();
  await expect(button).toBeEnabled();
  await expect(row).toBeVisible();

  postStatus = 409;
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.locator('#problems-feedback')).toContainText('Проверка уже выполняется');
});

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
  let terminalRequests = 0;
  let targetId = '';

  await page.route('**/api/images?**', async route => {
    const response = await route.fetch();
    const data = await response.json();
    if (terminalSeen && Array.isArray(data.items)) {
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
    terminalSeen = true;
    terminalRequests += 1;
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
});

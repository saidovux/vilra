import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

type ImageItem = {
  id: string;
  path: string;
  thumb_url?: string;
  width?: number;
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
  }
});

test('/file id API returns originals and cleanly rejects unknown ids', async ({ page }) => {
  const [image] = await imageItems(page, 10);
  expect(image?.id).toBeTruthy();

  const valid = await page.request.get(`/file/${image.id}`);
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

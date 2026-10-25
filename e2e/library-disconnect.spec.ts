import {expect, test, type APIRequestContext, type Page} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

type E2EState = {fixtureDir: string};
type ImageItem = {id: string; path: string; user_tags?: string[]};

function e2eState(): E2EState {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '.run', 'e2e-runtime', 'state.json'), 'utf8'),
  ) as E2EState;
}

async function connectedRoots(request: APIRequestContext): Promise<string[]> {
  const response = await request.get('/api/session');
  expect(response.ok()).toBeTruthy();
  const session = await response.json();
  return Array.isArray(session.root_paths) ? session.root_paths.map(String) : [];
}

async function connectRoot(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.post('/api/folder', {data: {path: root}});
  expect(response.ok()).toBeTruthy();
}

async function disconnectRoot(request: APIRequestContext, root: string): Promise<void> {
  const response = await request.delete('/api/folders', {data: {path: root}});
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function findImage(request: APIRequestContext, imagePath: string): Promise<ImageItem | null> {
  const response = await request.get('/api/images?limit=200&include_total=1');
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return (Array.isArray(payload.items) ? payload.items : [])
    .find((image: ImageItem) => image.path === imagePath) || null;
}

async function disconnectThroughUi(page: Page, root: string): Promise<void> {
  page.once('dialog', dialog => dialog.accept());
  const button = page.locator(`[data-action="disconnect-folder"][data-root="${root}"]`);
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveCount(0);
}

test('libraries disconnect safely without deleting indexed data or restoring stale roots', async ({page}) => {
  const fixtureRoot = e2eState().fixtureDir;
  const temporaryRoot = path.resolve(__dirname, '..', '.run', 'e2e-disconnect-library');
  const relativeImage = 'disconnect-only.png';
  const sourceImage = path.join(fixtureRoot, 'batch-a', 'fixture-001.png');
  const userTag = `disconnect-keep-${Date.now()}`;
  fs.rmSync(temporaryRoot, {recursive: true, force: true});
  fs.mkdirSync(temporaryRoot, {recursive: true});
  fs.copyFileSync(sourceImage, path.join(temporaryRoot, relativeImage));
  fs.writeFileSync(path.join(temporaryRoot, 'disconnect-problem.jpg'), 'not a jpeg');

  try {
    await connectRoot(page.request, temporaryRoot);
    await expect.poll(async () => (await connectedRoots(page.request)).sort())
      .toEqual([fixtureRoot, temporaryRoot].sort());
    await expect.poll(async () => await findImage(page.request, relativeImage), {timeout: 30_000})
      .not.toBeNull();
    const original = await findImage(page.request, relativeImage);
    expect(original).not.toBeNull();
    const imageId = original?.id || '';
    const tagged = await page.request.post(`/api/tag/${imageId}`, {data: {tags: [userTag]}});
    expect(tagged.ok()).toBeTruthy();
    await expect.poll(async () => {
      const response = await page.request.get('/api/problems?severity=all&search=disconnect-problem&limit=10&offset=0');
      return (await response.json()).page?.total;
    }, {timeout: 30_000}).toBe(1);

    await page.goto('/');
    await expect(page.locator('#gallery-screen')).toBeVisible();
    await disconnectThroughUi(page, temporaryRoot);
    await expect.poll(async () => await findImage(page.request, relativeImage)).toBeNull();
    expect((await page.request.get(`/file/${imageId}`)).status()).toBe(404);
    expect((await page.request.get(`/thumb/${imageId}`)).status()).toBe(404);
    expect((await page.request.get(`/thumb-file/${imageId}.jpg`)).status()).toBe(404);
    await expect.poll(async () => {
      const response = await page.request.get('/api/problems?severity=all&search=disconnect-problem&limit=10&offset=0');
      return (await response.json()).page?.total;
    }).toBe(0);

    await connectRoot(page.request, temporaryRoot);
    await expect.poll(async () => await findImage(page.request, relativeImage), {timeout: 30_000})
      .not.toBeNull();
    const restoredImage = await findImage(page.request, relativeImage);
    expect(restoredImage?.id).toBe(imageId);
    expect(restoredImage?.user_tags).toContain(userTag);

    await page.reload();
    await expect(page.locator('#gallery-screen')).toBeVisible();
    await disconnectRoot(page.request, fixtureRoot);
    await page.reload();
    const card = page.locator(`.card[data-id="${imageId}"]`);
    await expect(card).toBeVisible({timeout: 30_000});
    await card.click();
    await expect(page.locator('#preview-modal')).toBeVisible();
    await disconnectRoot(page.request, temporaryRoot);
    await expect(page.locator(`[data-action="disconnect-folder"][data-root="${temporaryRoot}"]`))
      .toHaveCount(0);
    await expect(page.locator('#preview-modal')).not.toBeVisible();
    await expect(page.locator('#selection-count')).toHaveText('0');
    await expect(page.locator('#empty-state .label')).toHaveText('Библиотеки не добавлены');

    const empty = await page.request.get('/api/images?limit=20&include_total=1');
    expect(empty.ok()).toBeTruthy();
    const emptyPayload = await empty.json();
    expect(emptyPayload.items).toEqual([]);
    expect(emptyPayload.page.total).toBe(0);
    const status = await (await page.request.get('/api/status')).json();
    expect(status.root).toBeNull();
    expect(status.root_paths).toEqual([]);
    expect(status.ready).toBe(true);

    const stalePatch = await page.request.patch('/api/session', {
      data: {root_path: temporaryRoot, root_paths: [temporaryRoot], search_mode: 'all'},
    });
    expect(stalePatch.ok()).toBeTruthy();
    const staleSession = await stalePatch.json();
    expect(staleSession.root_path).toBeNull();
    expect(staleSession.root_paths).toEqual([]);
    expect(staleSession.search_mode).toBe('all');
  } finally {
    const roots = await connectedRoots(page.request).catch(() => []);
    for (const root of roots) {
      if (root !== fixtureRoot) await disconnectRoot(page.request, root).catch(() => undefined);
    }
    if (!(await connectedRoots(page.request).catch(() => [])).includes(fixtureRoot)) {
      await connectRoot(page.request, fixtureRoot).catch(() => undefined);
    }
    await page.request.delete(`/api/tags/${encodeURIComponent(userTag)}`).catch(() => undefined);
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  }
});

test('late gallery responses and filesystem events cannot restore a disconnected library', async ({page}) => {
  const root = '/synthetic/disconnect-race';
  const image = {
    id: 'disconnect-race-image',
    path: 'late.png',
    thumb: '.imgindex/thumbs/disconnect-race-image.jpg',
    thumb_url: '/thumb-file/disconnect-race-image.jpg',
    size: 10,
    mtime: 10,
    width: 20,
    height: 10,
    aspect_ratio: 2,
    tags: [],
    auto_tags: [],
    folder_tags: [],
    user_tags: [],
  };
  let disconnected = false;
  let imageRequests = 0;
  let releaseOldResponse: (() => void) | undefined;
  let signalOldRequest: (() => void) | undefined;
  const oldResponseGate = new Promise<void>(resolve => { releaseOldResponse = resolve; });
  const oldRequestStarted = new Promise<void>(resolve => { signalOldRequest = resolve; });
  let releaseLateEvent: (() => void) | undefined;
  const lateEventGate = new Promise<void>(resolve => { releaseLateEvent = resolve; });
  let eventRequests = 0;

  await page.route('**/api/session', route => route.fulfill({json: {
    root_path: disconnected ? null : root,
    root_paths: disconnected ? [] : [root],
    search_tags: [],
    search_mode: 'any',
    last_image_id: null,
    tabs: [],
    active_tab_id: null,
    folder_tag_sync: true,
  }}));
  await page.route('**/api/status', route => route.fulfill({json: {
    ready: true,
    db_ready: true,
    root: disconnected ? null : root,
    root_paths: disconnected ? [] : [root],
    running: false,
    queued: false,
    total: disconnected ? 0 : 1,
    done: disconnected ? 0 : 1,
    error: null,
  }}));
  await page.route('**/api/folders', async route => {
    if (route.request().method() === 'DELETE') {
      disconnected = true;
      await route.fulfill({json: {ok: true, removed: root, root: null, root_paths: []}});
      return;
    }
    await route.fulfill({json: {roots: disconnected ? [] : [root], items: []}});
  });
  await page.route('**/api/tags', route => route.fulfill({json: {tags: []}}));
  await page.route('**/api/problems/summary', route => route.fulfill({json: {
    total: 0, errors: 0, warnings: 0, latest_updated_at: null,
  }}));
  await page.route('**/api/images?**', async route => {
    imageRequests += 1;
    if (imageRequests === 2) {
      signalOldRequest?.();
      await oldResponseGate;
    }
    const items = disconnected ? [] : [image];
    await route.fulfill({json: {
      items,
      images: items,
      page: {total: items.length, next_cursor: null, has_more: false, returned: items.length},
    }});
  });
  await page.route('**/api/events*', async route => {
    eventRequests += 1;
    if (eventRequests > 1) {
      await route.fulfill({status: 200, contentType: 'text/event-stream', body: ''});
      return;
    }
    await lateEventGate;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `id: 7001\ndata: ${JSON.stringify({sequence: 7001, type: 'image_created', data: {root_path: root, image}})}\n\n`,
    });
  });
  await page.route('**/thumb-file/**', route => route.fulfill({status: 404, body: ''}));

  await page.goto('/');
  await expect(page.locator('.card[data-id="disconnect-race-image"]')).toBeVisible();
  await page.locator('#sort-select').selectOption('path_desc');
  await oldRequestStarted;
  page.once('dialog', dialog => dialog.accept());
  await page.locator(`[data-action="disconnect-folder"][data-root="${root}"]`).click();
  await expect(page.locator('#empty-state .label')).toHaveText('Библиотеки не добавлены');

  releaseOldResponse?.();
  releaseLateEvent?.();
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await expect(page.locator('.card[data-id="disconnect-race-image"]')).toHaveCount(0);
  await expect(page.locator(`[data-action="disconnect-folder"][data-root="${root}"]`)).toHaveCount(0);
});

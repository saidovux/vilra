import {expect, test, type Page, type Route} from '@playwright/test';

const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

type PreviewFixture = {
  controls: Map<string, Deferred>;
  originalRequests: string[];
};

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

function image(id: string, index: number) {
  return {
    id,
    path: `preview/${id}.png`,
    thumb_url: `/thumb-file/${id}.jpg`,
    width: 1,
    height: 1,
    size: 1024 + index,
    mtime: 100 - index,
    tags: [],
    auto_tags: [],
    folder_tags: [],
    user_tags: [],
  };
}

async function fulfillOriginal(route: Route, wait: Deferred): Promise<void> {
  await wait.promise;
  await route.fulfill({status: 200, contentType: 'image/png', body: IMAGE_BYTES}).catch(() => undefined);
}

async function installPreviewFixture(page: Page): Promise<PreviewFixture> {
  const ids = ['preview-a', 'preview-b', 'preview-c'];
  const controls = new Map(ids.map(id => [id, deferred()]));
  const originalRequests: string[] = [];

  await page.route('**/api/events', route => route.abort());
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'GET') {
      await route.fulfill({status: 200, json: {ok: true}});
      return;
    }
    await route.fulfill({status: 200, json: {
      root_path: '/preview-fixture',
      root_paths: ['/preview-fixture'],
      search_tags: [],
      search_mode: 'any',
      tabs: [],
      active_tab_id: null,
      last_image_id: null,
      folder_tag_sync: true,
    }});
  });
  await page.route('**/api/images?**', route => route.fulfill({status: 200, json: {
    items: ids.map(image),
    page: {total: ids.length, next_cursor: null, has_more: false},
  }}));
  await page.route('**/thumb-file/preview-*.jpg*', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: IMAGE_BYTES,
  }));
  await page.route('**/thumb/preview-*', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: IMAGE_BYTES,
  }));
  await page.route('**/file/preview-*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop() || '';
    originalRequests.push(id);
    const control = controls.get(id);
    if (!control) {
      await route.fulfill({status: 404});
      return;
    }
    await fulfillOriginal(route, control);
  });

  return {controls, originalRequests};
}

async function openFixture(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.card[data-id="preview-a"]')).toBeVisible();
}

test('preview opens thumbnail-first, upgrades to native original, and creates no natural-size canvas', async ({page}) => {
  const fixture = await installPreviewFixture(page);
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  const modal = page.locator('#preview-modal');
  const stage = page.locator('#preview-image-stage');
  const thumbnail = page.locator('#preview-modal-thumbnail');
  const original = page.locator('#preview-modal-image');

  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute('data-image-id', 'preview-a');
  await expect(thumbnail).toHaveAttribute('data-state', 'ready');
  await expect(original).toHaveAttribute('data-state', 'loading');
  await expect(stage).toHaveAttribute('data-original-state', 'loading');
  await expect(page.locator('#preview-name')).toContainText('Загрузка:');
  await expect(page.locator('#preview-modal canvas')).toHaveCount(0);
  expect(fixture.originalRequests).toEqual(['preview-a']);

  fixture.controls.get('preview-a')?.resolve();
  await expect(original).toHaveAttribute('data-state', 'ready');
  await expect(stage).toHaveClass(/original-ready/);
  await expect(page.locator('#preview-name')).toHaveText('preview-a.png');
  await expect(original).toHaveCSS('opacity', '1');
  await expect(thumbnail).toHaveCSS('opacity', '0');
  expect(fixture.originalRequests).toEqual(['preview-a']);

  const zoomBefore = await page.locator('#zoom-level').textContent();
  const box = await stage.boundingBox();
  expect(box).toBeTruthy();
  await stage.dispatchEvent('wheel', {deltaY: 100, clientX: box!.x + box!.width / 2, clientY: box!.y + box!.height / 2});
  await expect.poll(() => page.locator('#zoom-level').textContent()).not.toBe(zoomBefore);
});

test('late A and B completions cannot replace C during rapid navigation', async ({page}) => {
  const fixture = await installPreviewFixture(page);
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'preview-a');
  await page.locator('#preview-next').click();
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'preview-b');
  await page.locator('#preview-next').click();
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'preview-c');

  fixture.controls.get('preview-c')?.resolve();
  await expect(page.locator('#preview-modal-image')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#preview-modal-image')).toHaveAttribute('src', /\/file\/preview-c$/);
  fixture.controls.get('preview-a')?.resolve();
  fixture.controls.get('preview-b')?.resolve();
  await page.waitForTimeout(200);

  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'preview-c');
  await expect(page.locator('#preview-modal-image')).toHaveAttribute('src', /\/file\/preview-c$/);
  await expect(page.locator('#preview-name')).toHaveText('preview-c.png');
  expect([...new Set(fixture.originalRequests)].sort()).toEqual(['preview-a', 'preview-b', 'preview-c']);
});

test('closing during original load releases media and late completion cannot mutate the modal', async ({page}) => {
  const fixture = await installPreviewFixture(page);
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  await expect(page.locator('#preview-modal')).toBeVisible();
  await page.locator('#preview-close').click();
  await expect(page.locator('#preview-modal')).not.toBeVisible();
  await expect(page.locator('#preview-modal-image')).not.toHaveAttribute('src', /.+/);

  fixture.controls.get('preview-a')?.resolve();
  await page.waitForTimeout(200);
  await expect(page.locator('#preview-modal')).not.toBeVisible();
  await expect(page.locator('#preview-modal-image')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('#preview-modal')).not.toHaveAttribute('data-image-id', /.+/);
});

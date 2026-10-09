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

type PreviewFixtureOptions = {
  width?: number;
  height?: number;
};

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

function image(id: string, index: number, options: PreviewFixtureOptions = {}) {
  return {
    id,
    path: `preview/${id}.png`,
    thumb_url: `/thumb-file/${id}.jpg`,
    width: options.width ?? 1,
    height: options.height ?? 1,
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

async function installPreviewFixture(page: Page, options: PreviewFixtureOptions = {}): Promise<PreviewFixture> {
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
    items: ids.map((id, index) => image(id, index, options)),
    page: {total: ids.length, next_cursor: null, has_more: false},
  }}));
  await page.route('**/api/tags', route => route.fulfill({status: 200, json: {tags: ['hiking']}}));
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

test('Vilra selects disable native appearance and keep dark platform-independent styling', async ({page}) => {
  await installPreviewFixture(page);
  await openFixture(page);

  const selectStyle = async (selector: string) => page.locator(selector).evaluate(element => {
    const style = getComputedStyle(element);
    return {
      appearance: style.getPropertyValue('appearance'),
      webkitAppearance: style.getPropertyValue('-webkit-appearance'),
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      color: style.color,
    };
  });

  const gallerySort = page.locator('#sort-select');
  await expect(gallerySort).toHaveCount(1);
  expect(await gallerySort.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['date_desc', 'date_asc', 'path_asc', 'path_desc', 'size_desc', 'size_asc']);

  await page.locator('#settings-toggle').click();
  await page.locator('[data-settings-tab="tags"]').click();
  const tagSort = page.locator('#tag-admin-sort');
  await expect(tagSort).toBeVisible();
  expect(await tagSort.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
    .toEqual(['name', 'image_count', 'user_count', 'auto_count']);

  for (const selector of ['#sort-select', '#tag-admin-sort']) {
    const style = await selectStyle(selector);
    expect(style.appearance).toBe('none');
    expect(style.webkitAppearance).toBe('none');
    expect(style.backgroundColor).toBe('rgb(11, 11, 11)');
    expect(style.backgroundImage).not.toBe('none');
    expect(style.color).toBe('rgb(255, 255, 255)');
  }
});

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

test('viewer Focus and Inspector controls preserve layout state through navigation', async ({page}) => {
  const fixture = await installPreviewFixture(page);
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  const modal = page.locator('#preview-modal');
  await expect(modal).toBeVisible();
  await expect(page.locator('#zoom-level')).toHaveText('FIT');
  await expect(page.locator('#preview-modal-thumbnail')).toHaveCSS('object-fit', 'contain');
  await expect(page.locator('#preview-modal-image')).toHaveCSS('object-fit', 'contain');
  await expect(page.locator('#preview-film-modes button')).toHaveText([
    'Nearby',
    'Similar',
    'Same tag',
    'Folder',
    'Linked',
  ]);
  await expect(page.locator('#preview-film-modes button').first()).toBeVisible();

  await page.locator('[data-action="preview-one-to-one"]').click();
  await expect(page.locator('#zoom-level')).toHaveText('100%');
  await page.locator('[data-action="preview-zoom"][data-factor="1.2"]').click();
  await expect(page.locator('#zoom-level')).toHaveText('120%');
  await page.locator('[data-action="preview-zoom"][data-factor="0.833333"]').click();
  await expect(page.locator('#zoom-level')).toHaveText('100%');
  await page.locator('[data-action="preview-fit"]').click();
  await expect(page.locator('#zoom-level')).toHaveText('FIT');

  await expect(page.locator('#preview-focus-toggle')).toContainText('Focus');
  await expect(page.locator('#preview-focus-toggle')).toContainText('Tab');
  await page.keyboard.press('1');
  await expect(page.locator('#zoom-level')).toHaveText('100%');
  await page.keyboard.press('Shift+=');
  await expect(page.locator('#zoom-level')).toHaveText('120%');
  await page.keyboard.press('-');
  await expect(page.locator('#zoom-level')).toHaveText('100%');
  await page.keyboard.press('=');
  await expect(page.locator('#zoom-level')).toHaveText('120%');
  await page.keyboard.press('f');
  await expect(page.locator('#zoom-level')).toHaveText('FIT');
  await page.keyboard.press('i');
  await expect(page.locator('#zoom-level')).toHaveText('120%');
  await page.keyboard.press('o');
  await expect(page.locator('#zoom-level')).toHaveText('100%');
  await page.keyboard.press('Shift+f');
  await expect(page.locator('#zoom-level')).toHaveText('FIT');
  await expect(modal).not.toHaveClass(/preview-focus-mode/);
  await expect(page.locator('#preview-inspector')).toBeVisible();

  await modal.dispatchEvent('keydown', {key: 'i', ctrlKey: true, bubbles: true, cancelable: true});
  await modal.dispatchEvent('keydown', {key: 'o', altKey: true, bubbles: true, cancelable: true});
  await modal.dispatchEvent('keydown', {key: 'p', metaKey: true, bubbles: true, cancelable: true});
  await modal.dispatchEvent('keydown', {key: 'n', ctrlKey: true, bubbles: true, cancelable: true});
  await expect(page.locator('#zoom-level')).toHaveText('FIT');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-a');

  await page.keyboard.press('Control+b');
  await expect(modal).toHaveClass(/preview-inspector-hidden/);
  await expect(modal).not.toHaveClass(/preview-focus-mode/);
  await expect(page.locator('#preview-toolbar')).toBeVisible();
  await expect(page.locator('#preview-inspector')).not.toBeVisible();
  await expect(page.locator('#preview-filmstrip')).toBeVisible();
  const normalHiddenInspectorStage = await page.locator('#preview-stage-viewport').boundingBox();
  const viewport = page.viewportSize();
  expect(normalHiddenInspectorStage).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(Math.abs(normalHiddenInspectorStage!.width - viewport!.width)).toBeLessThanOrEqual(1);
  expect(normalHiddenInspectorStage!.y).toBeGreaterThan(0);
  expect(normalHiddenInspectorStage!.height).toBeLessThan(viewport!.height);
  await page.keyboard.press('Control+b');
  await expect(modal).not.toHaveClass(/preview-inspector-hidden/);

  await page.locator('[data-action="preview-fit"]').click();
  await page.keyboard.press('Tab');
  await expect(modal).toHaveClass(/preview-focus-mode/);
  await expect(modal).toHaveClass(/preview-inspector-hidden/);
  await expect(page.locator('#preview-toolbar')).not.toBeVisible();
  await expect(page.locator('#preview-inspector')).not.toBeVisible();
  await expect(page.locator('#preview-filmstrip')).not.toBeVisible();
  await expect(page.locator('#preview-prev')).not.toBeVisible();
  await expect(page.locator('#preview-next')).not.toBeVisible();
  const focusStage = await page.locator('#preview-stage-viewport').boundingBox();
  expect(focusStage).toBeTruthy();
  expect(Math.abs(focusStage!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusStage!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusStage!.width - viewport!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusStage!.height - viewport!.height)).toBeLessThanOrEqual(1);
  const focusedImageStage = await page.locator('#preview-image-stage').boundingBox();
  expect(focusedImageStage!.width).toBeGreaterThan(1);
  expect(focusedImageStage!.height).toBeGreaterThan(1);

  await page.keyboard.press('p');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-b');
  await expect(modal).toHaveClass(/preview-focus-mode/);
  await expect(modal).toHaveClass(/preview-inspector-hidden/);
  await page.keyboard.press('p');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-c');
  await expect(modal).toHaveClass(/preview-focus-mode/);

  await page.keyboard.press('Control+b');
  await expect(modal).toHaveClass(/preview-focus-mode/);
  await expect(modal).not.toHaveClass(/preview-inspector-hidden/);
  await expect(page.locator('#preview-inspector')).toBeVisible();
  await expect(page.locator('#preview-toolbar')).not.toBeVisible();
  const focusInspectorStage = await page.locator('#preview-stage-viewport').boundingBox();
  const focusInspector = await page.locator('#preview-inspector').boundingBox();
  expect(focusInspectorStage).toBeTruthy();
  expect(focusInspector).toBeTruthy();
  expect(Math.abs(focusInspectorStage!.width - (viewport!.width - 292))).toBeLessThanOrEqual(1);
  expect(Math.abs(focusInspectorStage!.height - viewport!.height)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusInspector!.x - (viewport!.width - 292))).toBeLessThanOrEqual(1);
  expect(Math.abs(focusInspector!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusInspector!.height - viewport!.height)).toBeLessThanOrEqual(1);
  await page.keyboard.press('n');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-b');
  await expect(modal).toHaveClass(/preview-focus-mode/);
  await expect(modal).not.toHaveClass(/preview-inspector-hidden/);
  await page.keyboard.press('ArrowRight');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-c');
  await page.keyboard.press('ArrowLeft');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-b');
  await expect(modal).toHaveClass(/preview-focus-mode/);
  await expect(modal).not.toHaveClass(/preview-inspector-hidden/);

  await page.keyboard.press('Tab');
  await expect(modal).not.toHaveClass(/preview-focus-mode/);
  await expect(modal).not.toHaveClass(/preview-inspector-hidden/);
  await expect(page.locator('#preview-toolbar')).toBeVisible();
  await expect(page.locator('#preview-inspector')).toBeVisible();
  await expect(page.locator('#preview-filmstrip')).toBeVisible();
  await page.locator('.preview-film-item[title="preview-c.png"]').click();
  await expect(modal).toHaveAttribute('data-image-id', 'preview-c');

  fixture.controls.get('preview-a')?.resolve();
  fixture.controls.get('preview-b')?.resolve();
  fixture.controls.get('preview-c')?.resolve();
  await page.keyboard.press('Escape');
  await expect(modal).not.toBeVisible();
  await page.locator('.card[data-id="preview-b"]').click();
  await expect(modal).toBeVisible();
  await expect(modal).not.toHaveClass(/preview-focus-mode/);
  await expect(modal).not.toHaveClass(/preview-inspector-hidden/);
  await expect(page.locator('#preview-inspector')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('viewer HJKL pans one shared constrained image transform', async ({page}) => {
  await installPreviewFixture(page, {width: 1600, height: 1200});
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  await page.keyboard.press('1');
  await expect(page.locator('#zoom-level')).toHaveText('100%');
  const stage = page.locator('#preview-image-stage');
  const initial = await stage.boundingBox();
  expect(initial).toBeTruthy();
  expect(initial!.width).toBeGreaterThan(page.viewportSize()!.width);
  expect(initial!.height).toBeGreaterThan(page.viewportSize()!.height);

  await page.keyboard.press('h');
  const left = await stage.boundingBox();
  expect(left!.x).toBeLessThan(initial!.x - 10);
  await page.keyboard.press('l');
  const right = await stage.boundingBox();
  expect(right!.x).toBeGreaterThan(left!.x + 10);

  await page.keyboard.press('j');
  const down = await stage.boundingBox();
  expect(down!.y).toBeLessThan(right!.y - 10);
  await page.keyboard.press('k');
  const up = await stage.boundingBox();
  expect(up!.y).toBeGreaterThan(down!.y + 10);

  const beforeModifiedKeys = await stage.boundingBox();
  await stage.dispatchEvent('keydown', {key: 'h', ctrlKey: true, bubbles: true, cancelable: true});
  await stage.dispatchEvent('keydown', {key: 'j', altKey: true, bubbles: true, cancelable: true});
  await stage.dispatchEvent('keydown', {key: 'k', metaKey: true, bubbles: true, cancelable: true});
  await stage.dispatchEvent('keydown', {key: 'L', shiftKey: true, bubbles: true, cancelable: true});
  const afterModifiedKeys = await stage.boundingBox();
  expect(afterModifiedKeys!.x).toBeCloseTo(beforeModifiedKeys!.x, 1);
  expect(afterModifiedKeys!.y).toBeCloseTo(beforeModifiedKeys!.y, 1);
});

test('app layout shortcuts do not intercept text controls or contenteditable', async ({page}) => {
  await installPreviewFixture(page);
  await openFixture(page);

  const gallery = page.locator('#gallery-screen');
  const sidebar = page.locator('#folder-sidebar');
  await page.locator('#sort-select').focus();
  await page.keyboard.press('Tab');
  await expect(gallery).not.toHaveClass(/gallery-focus-mode/);

  await page.locator('#filter-tag-input').focus();
  await page.keyboard.press('Control+b');
  await expect(sidebar).not.toHaveClass(/collapsed/);

  await page.evaluate(() => {
    const editable = document.createElement('div');
    editable.id = 'shortcut-contenteditable';
    editable.contentEditable = 'true';
    document.body.appendChild(editable);
    editable.focus();
  });
  await page.keyboard.press('Tab');
  await expect(gallery).not.toHaveClass(/gallery-focus-mode/);

  await page.locator('.card[data-id="preview-a"]').click();
  const modal = page.locator('#preview-modal');
  const previewInput = page.locator('#preview-tag-input');
  await previewInput.focus();
  const zoomBeforeTyping = await page.locator('#zoom-level').textContent();
  await page.keyboard.type('hijklopn');
  await expect(previewInput).toHaveValue('hijklopn');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-a');
  await expect(page.locator('#zoom-level')).toHaveText(zoomBeforeTyping || 'FIT');
  await expect(modal).not.toHaveClass(/preview-focus-mode/);

  await previewInput.fill('hik');
  await expect(page.locator('#preview-tag-ghost')).toContainText('hiking');
  await page.keyboard.press('Tab');
  await expect(previewInput).toHaveValue('hiking');
  await expect(modal).not.toHaveClass(/preview-focus-mode/);
});

test('viewer quick actions open for the current image by right click and Space', async ({page}) => {
  const fixture = await installPreviewFixture(page);
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  const modal = page.locator('#preview-modal');
  const menu = page.locator('#quickMenu');
  await modal.click({button: 'right', position: {x: 320, y: 240}});
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-image-id', 'preview-a');
  await expect(menu.locator('button')).toHaveText([
    'Tag',
    'Note',
    'Link',
    'Similar',
    'Reveal in folder',
    'Original',
    'Delete',
  ]);

  await menu.locator('[data-quick-action="Tag"]').click();
  await expect(menu).not.toBeVisible();
  await expect(page.locator('#preview-tag-input')).toBeFocused();

  await page.locator('#preview-next').click();
  await expect(modal).toHaveAttribute('data-image-id', 'preview-b');
  await page.keyboard.press('Space');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-image-id', 'preview-b');
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(modal).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-c');
  fixture.controls.forEach(control => control.resolve());
  await page.keyboard.press('Escape');
  await expect(modal).not.toBeVisible();
});

test('multi-select keeps cards mounted and exposes the literal selection tray', async ({page}) => {
  await installPreviewFixture(page);
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click({modifiers: ['Control']});
  await expect(page.locator('#selection-tray')).toBeVisible();
  await expect(page.locator('#selection-count')).toHaveText('1');
  await expect(page.locator('#selection-tray')).toContainText('selected');
  await expect(page.locator('#selection-tray')).toContainText('Tags');
  await expect(page.locator('#selection-tray')).toContainText('Link');
  await expect(page.locator('#selection-tray')).toContainText('Move');
  await expect(page.locator('#selection-tray')).toContainText('Remove');

  await page.locator('.card[data-id="preview-b"]').click();
  await expect(page.locator('#selection-count')).toHaveText('2');
  await expect(page.locator('.card.selected')).toHaveCount(2);
  await page.locator('[data-action="clear-image-selection"]').click();
  await expect(page.locator('#selection-tray')).not.toBeVisible();
  await expect(page.locator('.card.selected')).toHaveCount(0);
});

for (const viewport of [
  {width: 1366, height: 768},
  {width: 1920, height: 1080},
]) {
  test(`V3.1 shell and viewer geometry matches ${viewport.width}x${viewport.height}`, async ({page}) => {
    await installPreviewFixture(page);
    await page.setViewportSize(viewport);
    await openFixture(page);

    const box = async (selector: string) => {
      const value = await page.locator(selector).boundingBox();
      expect(value, selector).toBeTruthy();
      return value!;
    };
    const closeTo = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);

    const topbar = await box('#topbar');
    const filter = await box('#filter-bar');
    const sidebar = await box('#folder-sidebar');
    const chips = await box('#selected-filter-tags');
    closeTo(topbar.y, 0);
    closeTo(topbar.height, 46);
    closeTo(filter.y, 46);
    closeTo(filter.height, 82);
    closeTo(sidebar.x, 0);
    closeTo(sidebar.y, 128);
    closeTo(sidebar.width, 276);
    expect(await page.locator('#selected-filter-tags').evaluate(element => element.parentElement?.id)).toBe('filter-bar');
    await expect(page.locator('#selected-filter-tags')).not.toHaveCSS('position', 'sticky');
    closeTo(chips.x, 0);
    closeTo(chips.y, 93);
    closeTo(chips.width, viewport.width);
    closeTo(chips.height, 34);

    await page.locator('#gallery').evaluate(element => { element.style.minHeight = '1800px'; });
    await page.evaluate(() => window.scrollTo({top: 420}));
    await expect(page.locator('#topbar')).toBeVisible();
    await expect(page.locator('#filter-bar')).toBeVisible();
    await expect(page.locator('#folder-sidebar')).toBeVisible();
    await expect(page.locator('body')).not.toHaveClass(/chrome-hidden/);
    await expect(page.locator('html')).not.toHaveClass(/chrome-hidden/);
    await page.evaluate(() => window.scrollTo({top: 0}));

    await page.locator('.card[data-id="preview-a"]').click();
    const toolbar = await box('#preview-toolbar');
    const stage = await box('#preview-stage-viewport');
    const inspector = await box('#preview-inspector');
    const filmstrip = await box('#preview-filmstrip');
    const zoom = await box('.preview-zoom-cluster');
    closeTo(toolbar.y, 0);
    closeTo(toolbar.height, 44);
    closeTo(stage.x, 0);
    closeTo(stage.y, 44);
    closeTo(stage.width, viewport.width - 292);
    closeTo(stage.height, viewport.height - 44 - 92);
    closeTo(inspector.x, viewport.width - 292);
    closeTo(inspector.y, 44);
    closeTo(inspector.width, 292);
    closeTo(inspector.height, viewport.height - 44);
    closeTo(filmstrip.x, 0);
    closeTo(filmstrip.y, viewport.height - 92);
    closeTo(filmstrip.width, viewport.width - 292);
    closeTo(filmstrip.height, 92);
    closeTo(zoom.width, 160);
  });
}

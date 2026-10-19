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
  tagRequests: Array<{id: string; tags: string[]}>;
  sessionWrites: Array<{last_image_id?: string | null}>;
};

type PreviewFixtureOptions = {
  width?: number;
  height?: number;
  ids?: string[];
  lastImageId?: string | null;
  immediateOriginals?: boolean;
};

type FilmstripSnapshot = {
  count: number;
  remaining: number;
  pitch: number;
  itemWidth: number;
  itemHeight: number;
  titles: string[];
  activeTitle: string | null;
};

type PreviewGeometry = {
  stage: {x: number; y: number; width: number; height: number};
  viewport: {x: number; y: number; width: number; height: number};
};

type PaginatedPreviewFixture = {
  cursorRequests: string[];
  sessionWrites: Array<{last_image_id?: string | null}>;
  releaseNextPage: () => void;
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
  const ids = options.ids || ['preview-a', 'preview-b', 'preview-c'];
  const controls = new Map(ids.map(id => [id, deferred()]));
  const originalRequests: string[] = [];
  const tagRequests: Array<{id: string; tags: string[]}> = [];
  const sessionWrites: Array<{last_image_id?: string | null}> = [];

  await page.route('**/api/events', route => route.abort());
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'GET') {
      sessionWrites.push(route.request().postDataJSON() as {last_image_id?: string | null});
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
      last_image_id: options.lastImageId || null,
      folder_tag_sync: true,
    }});
  });
  await page.route('**/api/images?**', route => route.fulfill({status: 200, json: {
    items: ids.map((id, index) => image(id, index, options)),
    page: {total: ids.length, next_cursor: null, has_more: false},
  }}));
  await page.route('**/api/tags', route => route.fulfill({status: 200, json: {tags: ['hiking']}}));
  await page.route('**/api/tag/preview-*', async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop() || '';
    const body = route.request().postDataJSON() as {tags?: string[]};
    const tags = Array.isArray(body.tags) ? body.tags : [];
    tagRequests.push({id, tags});
    await route.fulfill({status: 200, json: {
      tags,
      auto_tags: [],
      folder_tags: [],
      user_tags: tags,
    }});
  });
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
    if (options.immediateOriginals) {
      await route.fulfill({status: 200, contentType: 'image/png', body: IMAGE_BYTES});
      return;
    }
    const control = controls.get(id);
    if (!control) {
      await route.fulfill({status: 404});
      return;
    }
    await fulfillOriginal(route, control);
  });

  return {controls, originalRequests, tagRequests, sessionWrites};
}

async function openFixture(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.card[data-id="preview-a"]')).toBeVisible();
}

function pagedImageId(index: number): string {
  return `paged-${String(index).padStart(3, '0')}`;
}

async function installPaginatedPreviewFixture(
  page: Page,
  lastImageIndex: number,
  secondPageCount = 48,
): Promise<PaginatedPreviewFixture> {
  const nextPage = deferred();
  const cursorRequests: string[] = [];
  const sessionWrites: Array<{last_image_id?: string | null}> = [];
  const firstPage = Array.from({length: 48}, (_, index) => image(pagedImageId(index), index));
  const secondPage = Array.from(
    {length: secondPageCount},
    (_, index) => image(pagedImageId(48 + index), 48 + index),
  );

  await page.route('**/api/events', route => route.abort());
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'GET') {
      sessionWrites.push(route.request().postDataJSON() as {last_image_id?: string | null});
      await route.fulfill({status: 200, json: {ok: true}});
      return;
    }
    await route.fulfill({status: 200, json: {
      root_path: '/paginated-preview-fixture',
      root_paths: ['/paginated-preview-fixture'],
      search_tags: [],
      search_mode: 'any',
      tabs: [],
      active_tab_id: null,
      last_image_id: pagedImageId(lastImageIndex),
      folder_tag_sync: true,
    }});
  });
  await page.route('**/api/images?**', async route => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor) {
      cursorRequests.push(cursor);
      await nextPage.promise;
      await route.fulfill({status: 200, json: {
        items: secondPage,
        page: {total: null, next_cursor: null, has_more: false},
      }});
      return;
    }
    await route.fulfill({status: 200, json: {
      items: firstPage,
      page: {total: firstPage.length + secondPage.length, next_cursor: '48', has_more: true},
    }});
  });
  await page.route('**/api/tags', route => route.fulfill({status: 200, json: {tags: []}}));
  await page.route('**/thumb-file/paged-*.jpg*', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: IMAGE_BYTES,
  }));
  await page.route('**/thumb/paged-*', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: IMAGE_BYTES,
  }));
  await page.route('**/file/paged-*', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: IMAGE_BYTES,
  }));

  return {
    cursorRequests,
    sessionWrites,
    releaseNextPage: nextPage.resolve,
  };
}

async function expectGalleryCardInViewport(page: Page, imageId: string): Promise<void> {
  const slot = page.locator(`.virtual-card-slot[data-id="${imageId}"]`);
  await expect(slot).toBeVisible();
  const intersects = await slot.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight;
  });
  expect(intersects).toBe(true);
}

async function openFilmstripFixture(page: Page, currentIndex: number, imageCount = 64): Promise<string[]> {
  const ids = Array.from({length: imageCount}, (_, index) => `preview-${String(index).padStart(3, '0')}`);
  await installPreviewFixture(page, {
    ids,
    lastImageId: ids[currentIndex],
    immediateOriginals: true,
  });
  await page.setViewportSize({width: 1366, height: 768});
  await page.goto('/');
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', ids[currentIndex]);
  return ids;
}

async function filmstripSnapshot(page: Page): Promise<FilmstripSnapshot> {
  return page.locator('#preview-film-items').evaluate(element => {
    const target = element as HTMLElement;
    const items = [...target.querySelectorAll<HTMLElement>('.preview-film-item')];
    const last = items[items.length - 1];
    if (!last) throw new Error('filmstrip has no items');
    const targetRect = target.getBoundingClientRect();
    const itemRect = items[0].getBoundingClientRect();
    const lastRect = last.getBoundingClientRect();
    const style = getComputedStyle(target);
    const gap = Number.parseFloat(style.getPropertyValue('--preview-film-gap'));
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    return {
      count: items.length,
      remaining: targetRect.right - paddingRight - lastRect.right,
      pitch: itemRect.width + gap,
      itemWidth: itemRect.width,
      itemHeight: itemRect.height,
      titles: items.map(item => item.title),
      activeTitle: target.querySelector<HTMLElement>('.preview-film-item.active')?.title || null,
    };
  });
}

function expectFilledFilmstrip(snapshot: FilmstripSnapshot): void {
  expect(snapshot.remaining).toBeGreaterThanOrEqual(-1);
  expect(snapshot.remaining).toBeLessThan(snapshot.pitch + 1);
  expect(Math.abs(snapshot.itemWidth - 52)).toBeLessThanOrEqual(1);
  expect(Math.abs(snapshot.itemHeight - 50)).toBeLessThanOrEqual(1);
}

async function previewGeometry(page: Page): Promise<PreviewGeometry> {
  const [stage, viewport] = await Promise.all([
    page.locator('#preview-image-stage').boundingBox(),
    page.locator('#preview-stage-viewport').boundingBox(),
  ]);
  expect(stage, 'preview image stage').toBeTruthy();
  expect(viewport, 'preview viewport').toBeTruthy();
  return {stage: stage!, viewport: viewport!};
}

function expectTrueFit(
  geometry: PreviewGeometry,
  imageWidth: number,
  imageHeight: number,
  tolerance = 2,
): void {
  const {stage, viewport} = geometry;
  expect(stage.width).toBeLessThanOrEqual(viewport.width + tolerance);
  expect(stage.height).toBeLessThanOrEqual(viewport.height + tolerance);
  expect(Math.min(
    Math.abs(stage.width - viewport.width),
    Math.abs(stage.height - viewport.height),
  )).toBeLessThanOrEqual(tolerance);
  expect(stage.width / stage.height).toBeCloseTo(imageWidth / imageHeight, 2);

  const leftGap = stage.x - viewport.x;
  const rightGap = viewport.x + viewport.width - stage.x - stage.width;
  const topGap = stage.y - viewport.y;
  const bottomGap = viewport.y + viewport.height - stage.y - stage.height;
  expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(tolerance);
}

test('Nearby filmstrip fills visible width from the first image after opening', async ({page}) => {
  const ids = await openFilmstripFixture(page, 0);
  await expect.poll(() => page.locator('.preview-film-item').count()).toBeGreaterThan(8);

  const snapshot = await filmstripSnapshot(page);
  expect(snapshot.activeTitle).toBe(`${ids[0]}.png`);
  expect(snapshot.titles[0]).toBe(`${ids[0]}.png`);
  expectFilledFilmstrip(snapshot);
});

test('Nearby filmstrip keeps a filled centered window around a middle image', async ({page}) => {
  const ids = await openFilmstripFixture(page, 32);
  await expect.poll(() => page.locator('.preview-film-item').count()).toBeGreaterThan(15);

  const snapshot = await filmstripSnapshot(page);
  expect(snapshot.activeTitle).toBe(`${ids[32]}.png`);
  expect(snapshot.titles.indexOf(`${ids[32]}.png`)).toBeGreaterThan(0);
  expect(snapshot.titles.indexOf(`${ids[32]}.png`)).toBeLessThan(snapshot.count - 1);
  expect(snapshot.count).toBeLessThan(ids.length);
  expectFilledFilmstrip(snapshot);
});

test('Nearby filmstrip shifts left and fills width at the final image', async ({page}) => {
  const ids = await openFilmstripFixture(page, 63);
  await expect.poll(() => page.locator('.preview-film-item').count()).toBeGreaterThan(15);

  const snapshot = await filmstripSnapshot(page);
  expect(snapshot.activeTitle).toBe(`${ids[63]}.png`);
  expect(snapshot.titles[snapshot.titles.length - 1]).toBe(`${ids[63]}.png`);
  expect(snapshot.titles[0]).not.toBe(`${ids[63]}.png`);
  expectFilledFilmstrip(snapshot);
});

test('Nearby capacity follows Inspector, window resize, and leaving Focus mode', async ({page}) => {
  await openFilmstripFixture(page, 32);
  await expect.poll(() => page.locator('.preview-film-item').count()).toBeGreaterThan(15);
  const inspectorCount = await page.locator('.preview-film-item').count();

  await page.keyboard.press('Control+b');
  await expect(page.locator('#preview-inspector')).not.toBeVisible();
  await expect.poll(() => page.locator('.preview-film-item').count()).toBeGreaterThan(inspectorCount);
  const expandedCount = await page.locator('.preview-film-item').count();
  expectFilledFilmstrip(await filmstripSnapshot(page));

  await page.keyboard.press('Control+b');
  await expect(page.locator('#preview-inspector')).toBeVisible();
  await expect.poll(() => page.locator('.preview-film-item').count()).toBe(inspectorCount);

  await page.setViewportSize({width: 1600, height: 768});
  await expect.poll(() => page.locator('.preview-film-item').count()).toBeGreaterThan(inspectorCount);
  expect(await page.locator('.preview-film-item').count()).toBeLessThan(expandedCount + 8);

  const wideCount = await page.locator('.preview-film-item').count();
  await page.keyboard.press('Tab');
  await expect(page.locator('#preview-filmstrip')).not.toBeVisible();
  await page.setViewportSize({width: 1100, height: 768});
  await page.keyboard.press('Tab');
  await expect(page.locator('#preview-filmstrip')).toBeVisible();
  await expect.poll(() => page.locator('.preview-film-item').count()).toBeLessThan(wideCount);
  expectFilledFilmstrip(await filmstripSnapshot(page));
});

test('Nearby capacity resets before a fresh Viewer session is measured', async ({page}) => {
  const ids = await openFilmstripFixture(page, 32);
  await expect.poll(() => page.locator('.preview-film-item').count()).toBeGreaterThan(15);
  const inspectorCount = await page.locator('.preview-film-item').count();

  await page.keyboard.press('Control+b');
  await expect(page.locator('#preview-inspector')).not.toBeVisible();
  await expect.poll(() => page.locator('.preview-film-item').count()).toBeGreaterThan(inspectorCount);

  await page.keyboard.press('Escape');
  await expect(page.locator('#preview-modal')).not.toBeVisible();
  await expectGalleryCardInViewport(page, ids[32]);
  const preMeasurementCount = await page.locator(`.card[data-id="${ids[32]}"]`).evaluate(element => {
    (element as HTMLElement).click();
    return document.querySelectorAll('.preview-film-item').length;
  });

  expect(preMeasurementCount).toBe(15);
  await expect(page.locator('#preview-modal')).toBeVisible();
  await expect(page.locator('#preview-inspector')).toBeVisible();
  await expect.poll(() => page.locator('.preview-film-item').count()).toBe(inspectorCount);
  expectFilledFilmstrip(await filmstripSnapshot(page));
});

test('Viewer navigation hints match the functional P/N shortcuts', async ({page}) => {
  await installPreviewFixture(page, {immediateOriginals: true});
  await openFixture(page);

  await page.locator('.card[data-id="preview-b"]').click();
  const modal = page.locator('#preview-modal');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-b');
  await expect(page.locator('#preview-prev')).toHaveAttribute('title', 'Предыдущее · P / ←');
  await expect(page.locator('#preview-next')).toHaveAttribute('title', 'Следующее · N / →');

  await page.keyboard.press('p');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-a');
  await page.keyboard.press('n');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-b');
});

test('document root does not impose global smooth scrolling', async ({page}) => {
  await installPreviewFixture(page);
  await openFixture(page);

  await expect.poll(() => page.locator('html').evaluate(element => getComputedStyle(element).scrollBehavior))
    .toBe('auto');
});

test('Viewer crosses the Gallery cursor boundary and wraps only at the true end', async ({page}) => {
  const fixture = await installPaginatedPreviewFixture(page, 47, 2);
  await page.goto('/');
  const modal = page.locator('#preview-modal');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(47));
  await expect(page.locator('#preview-index')).toHaveText('48 / 48');

  await page.keyboard.press('n');
  await expect.poll(() => fixture.cursorRequests).toEqual(['48']);
  fixture.releaseNextPage();
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(48));
  await expect(page.locator('#preview-index')).toHaveText('49 / 50');

  await page.keyboard.press('ArrowRight');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(49));
  await page.keyboard.press('n');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(0));
  await expect(page.locator('#preview-index')).toHaveText('1 / 50');
  expect(fixture.cursorRequests).toEqual(['48']);
});

test('Viewer coalesces repeated navigation while one cursor page is loading', async ({page}) => {
  const fixture = await installPaginatedPreviewFixture(page, 47, 3);
  await page.goto('/');
  const modal = page.locator('#preview-modal');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(47));

  await page.keyboard.press('n');
  await page.keyboard.press('n');
  await page.keyboard.press('n');
  await expect.poll(() => fixture.cursorRequests).toEqual(['48']);
  fixture.releaseNextPage();

  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(49));
  await expect(page.locator('#preview-index')).toHaveText('50 / 51');
  expect(fixture.cursorRequests).toEqual(['48']);
});

test('Previous on the first image does not wrap before the final page is loaded', async ({page}) => {
  const fixture = await installPaginatedPreviewFixture(page, 0, 2);
  await page.goto('/');
  const modal = page.locator('#preview-modal');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(0));

  await page.keyboard.press('p');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(0));
  fixture.releaseNextPage();
});

test('closing Viewer invalidates navigation waiting for a cursor response', async ({page}) => {
  const fixture = await installPaginatedPreviewFixture(page, 47, 2);
  await page.goto('/');
  const modal = page.locator('#preview-modal');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(47));

  await page.keyboard.press('n');
  await expect.poll(() => fixture.cursorRequests).toEqual(['48']);
  await page.keyboard.press('q');
  await expect(modal).not.toBeVisible();
  fixture.releaseNextPage();
  await expect.poll(() => fixture.cursorRequests).toEqual(['48']);
  await page.waitForTimeout(100);
  await expect(modal).not.toBeVisible();
  await expect(modal).not.toHaveAttribute('data-image-id', /.+/);
});

test('normal Viewer close returns Gallery to the final image and clears session Viewer state', async ({page}) => {
  const fixture = await installPaginatedPreviewFixture(page, 47, 24);
  await page.goto('/');
  const modal = page.locator('#preview-modal');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(47));

  await page.keyboard.press('n');
  await expect.poll(() => fixture.cursorRequests).toEqual(['48']);
  fixture.releaseNextPage();
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(48));
  for (let index = 49; index <= 63; index += 1) await page.keyboard.press('n');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(63));

  await page.keyboard.press('q');
  await expect(modal).not.toBeVisible();
  await expectGalleryCardInViewport(page, pagedImageId(63));
  await expect.poll(() => {
    const latest = fixture.sessionWrites[fixture.sessionWrites.length - 1];
    return latest ? latest.last_image_id : undefined;
  }).toBeNull();

  await page.locator(`.card[data-id="${pagedImageId(63)}"]`).click();
  await page.keyboard.press('ArrowRight');
  await expect(modal).toHaveAttribute('data-image-id', pagedImageId(64));
  await page.locator('#preview-close').click();
  await expect(modal).not.toBeVisible();
  await expectGalleryCardInViewport(page, pagedImageId(64));
});

test('opening Settings preserves the active tab Viewer state without restoring the modal', async ({page}) => {
  const fixture = await installPreviewFixture(page, {immediateOriginals: true});
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'preview-a');
  await expect.poll(() => fixture.sessionWrites.at(-1)?.last_image_id).toBe('preview-a');

  await page.locator('#settings-toggle').dispatchEvent('click');
  await expect(page.locator('#settings-panel')).toBeVisible();
  await expect(page.locator('#preview-modal')).not.toBeVisible();
  expect(fixture.sessionWrites.at(-1)?.last_image_id).toBe('preview-a');

  await page.keyboard.press('q');
  await expect(page.locator('#settings-panel')).not.toBeVisible();
  await expect(page.locator('#preview-modal')).not.toBeVisible();
  expect(fixture.sessionWrites.at(-1)?.last_image_id).toBe('preview-a');
});

test('switching tabs closes Viewer without losing the previous tab image', async ({page}) => {
  await installPreviewFixture(page, {immediateOriginals: true});
  await openFixture(page);

  await page.locator('.card[data-id="preview-b"]').click();
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'preview-b');

  await page.keyboard.press('Control+t');
  await expect(page.locator('#preview-modal')).not.toBeVisible();
  await expect(page.locator('#tabs .tab[data-tab]')).toHaveCount(2);

  await page.keyboard.press('Alt+Digit1');
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'preview-b');
});

test('direct PreviewModal backdrop close runs lifecycle cleanup and clears session state', async ({page}) => {
  const fixture = await installPreviewFixture(page, {immediateOriginals: true});
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  await expect.poll(() => fixture.sessionWrites.at(-1)?.last_image_id).toBe('preview-a');
  await page.locator('#preview-modal').dispatchEvent('click');

  await expect(page.locator('#preview-modal')).not.toBeVisible();
  await expect.poll(() => fixture.sessionWrites.at(-1)?.last_image_id).toBeNull();
  await expectGalleryCardInViewport(page, 'preview-a');
});

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

test('Gallery tag suggestions replace the removed legacy tag manager and Ctrl+O focuses them', async ({page}) => {
  await installPreviewFixture(page);
  await openFixture(page);

  await expect(page.getByText('Список тегов', {exact: true})).toHaveCount(0);
  await expect(page.locator('[data-action="open-tag-manager"]')).toHaveCount(0);
  await expect(page.locator('#tag-overlay')).toHaveCount(0);
  await expect(page.locator('#tag-list')).toHaveCount(0);

  await page.locator('#sidebar-tag-search').focus();
  await page.keyboard.press('Control+KeyO');
  const input = page.locator('#filter-tag-input');
  await expect(input).toBeFocused();
  await expect(page.locator('#filter-suggestion-list')).toBeVisible();
  await expect(page.locator('#filter-suggestion-list')).toContainText('hiking');
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

test('delayed original HEAD result cannot mutate a newer Viewer image', async ({page}) => {
  await installPreviewFixture(page);
  const headGate = deferred();
  const headStarted = deferred();
  const dialogs: string[] = [];
  page.on('dialog', dialog => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.route('**/file/preview-a', async route => {
    if (route.request().method() === 'HEAD') {
      headStarted.resolve();
      await headGate.promise;
      await route.fulfill({status: 404});
      return;
    }
    await route.fulfill({status: 404});
  });
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  await headStarted.promise;
  await page.locator('#preview-next').click();
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'preview-b');
  headGate.resolve();
  await page.waitForTimeout(150);

  await expect(page.locator('#preview-name')).toContainText('preview-b.png');
  expect(dialogs).toEqual([]);
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

test('FIT uses the full limiting axis for a portrait image in Focus mode', async ({page}) => {
  await installPreviewFixture(page, {width: 1080, height: 1920});
  await page.setViewportSize({width: 1366, height: 768});
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  await expect(page.locator('#preview-modal-image')).toHaveAttribute('data-state', 'loading');
  await page.keyboard.press('Tab');
  await expect(page.locator('#preview-modal')).toHaveClass(/preview-focus-mode/);
  await expect(page.locator('#zoom-level')).toHaveText('FIT');

  const geometry = await previewGeometry(page);
  expectTrueFit(geometry, 1080, 1920);
  expect(Math.abs(geometry.stage.height - 768)).toBeLessThanOrEqual(2);
  expect(geometry.stage.width).toBeLessThan(geometry.viewport.width);
});

test('FIT follows landscape Viewer geometry through Inspector, resize, and Focus changes', async ({page}) => {
  await installPreviewFixture(page, {width: 1920, height: 1080});
  await page.setViewportSize({width: 1366, height: 768});
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  await expect(page.locator('#preview-modal-image')).toHaveAttribute('data-state', 'loading');
  expectTrueFit(await previewGeometry(page), 1920, 1080);

  await page.keyboard.press('Control+b');
  await expect(page.locator('#preview-inspector')).not.toBeVisible();
  expectTrueFit(await previewGeometry(page), 1920, 1080);

  await page.setViewportSize({width: 1600, height: 900});
  expectTrueFit(await previewGeometry(page), 1920, 1080);

  await page.keyboard.press('Tab');
  await expect(page.locator('#preview-modal')).toHaveClass(/preview-focus-mode/);
  const focusGeometry = await previewGeometry(page);
  expectTrueFit(focusGeometry, 1920, 1080);
  expect(Math.abs(focusGeometry.stage.width - focusGeometry.viewport.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(focusGeometry.stage.height - focusGeometry.viewport.height)).toBeLessThanOrEqual(2);
});

test('small-image FIT upscales while 1:1 and manual zoom remain distinct', async ({page}) => {
  await installPreviewFixture(page, {width: 400, height: 300});
  await page.setViewportSize({width: 1366, height: 768});
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  await expect(page.locator('#preview-modal-image')).toHaveAttribute('data-state', 'loading');
  const fitGeometry = await previewGeometry(page);
  expectTrueFit(fitGeometry, 400, 300);
  expect(fitGeometry.stage.width).toBeGreaterThan(400);
  expect(fitGeometry.stage.height).toBeGreaterThan(300);
  await expect(page.locator('#zoom-level')).toHaveText('FIT');

  await page.keyboard.press('1');
  await expect(page.locator('#zoom-level')).toHaveText('100%');
  const oneToOneGeometry = await previewGeometry(page);
  expect(Math.abs(oneToOneGeometry.stage.width - 400)).toBeLessThanOrEqual(1);
  expect(Math.abs(oneToOneGeometry.stage.height - 300)).toBeLessThanOrEqual(1);

  await page.keyboard.press('f');
  await expect(page.locator('#zoom-level')).toHaveText('FIT');
  const restoredFit = await previewGeometry(page);
  expectTrueFit(restoredFit, 400, 300);

  await page.keyboard.press('i');
  await expect(page.locator('#zoom-level')).toHaveText(/%$/);
  const zoomedGeometry = await previewGeometry(page);
  expect(zoomedGeometry.stage.width).toBeGreaterThan(restoredFit.stage.width);
  expect(zoomedGeometry.stage.height).toBeGreaterThan(restoredFit.stage.height);

  await page.keyboard.press('f');
  await expect(page.locator('#zoom-level')).toHaveText('FIT');
  expectTrueFit(await previewGeometry(page), 400, 300);
});

test('viewer Focus and Inspector controls preserve layout state through navigation', async ({page}) => {
  const fixture = await installPreviewFixture(page, {width: 1600, height: 1200});
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
  await expect(page.locator('#zoom-level')).toHaveText(/^\d+%$/);
  const zoomedInFromFit = Number.parseInt(await page.locator('#zoom-level').innerText(), 10);
  await page.keyboard.press('o');
  await expect(page.locator('#zoom-level')).toHaveText(/^\d+%$/);
  expect(Number.parseInt(await page.locator('#zoom-level').innerText(), 10)).toBeLessThan(zoomedInFromFit);
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

  await page.keyboard.press('n');
  await expect(modal).toHaveAttribute('data-image-id', 'preview-b');
  await expect(modal).toHaveClass(/preview-focus-mode/);
  await expect(modal).toHaveClass(/preview-inspector-hidden/);
  await page.keyboard.press('n');
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
  await page.keyboard.press('p');
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

  await page.keyboard.press('1');
  const beforeH = await stage.boundingBox();
  await page.keyboard.press('h');
  const afterH = await stage.boundingBox();
  expect(afterH!.x).toBeGreaterThan(beforeH!.x + 10);

  await page.keyboard.press('1');
  const beforeL = await stage.boundingBox();
  await page.keyboard.press('l');
  const afterL = await stage.boundingBox();
  expect(afterL!.x).toBeLessThan(beforeL!.x - 10);

  await page.keyboard.press('1');
  const beforeJ = await stage.boundingBox();
  await page.keyboard.press('j');
  const afterJ = await stage.boundingBox();
  expect(afterJ!.y).toBeLessThan(beforeJ!.y - 10);

  await page.keyboard.press('1');
  const beforeK = await stage.boundingBox();
  await page.keyboard.press('k');
  const afterK = await stage.boundingBox();
  expect(afterK!.y).toBeGreaterThan(beforeK!.y + 10);

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

test('Viewer T reveals the inspector, focuses repeat tagging, and preserves Focus mode', async ({page}) => {
  const fixture = await installPreviewFixture(page);
  await openFixture(page);

  await page.locator('.card[data-id="preview-a"]').click();
  const modal = page.locator('#preview-modal');
  const inspector = page.locator('#preview-inspector');
  const input = page.locator('#preview-tag-input');

  await page.keyboard.press('1');
  await page.keyboard.press('i');
  await expect(page.locator('#zoom-level')).toHaveText('120%');
  const ctrlOPrevented = await modal.evaluate(element => {
    const event = new KeyboardEvent('keydown', {
      key: 'o',
      code: 'KeyO',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(ctrlOPrevented).toBe(true);
  await expect(page.locator('#zoom-level')).toHaveText('120%');
  await expect(page.locator('#filter-tag-input')).not.toBeFocused();
  await page.keyboard.press('o');
  await expect(page.locator('#zoom-level')).toHaveText('100%');

  await page.keyboard.press('Control+b');
  await expect(inspector).not.toBeVisible();
  await page.keyboard.press('t');
  await expect(inspector).toBeVisible();
  await expect(input).toBeFocused();

  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  await expect(page.locator('#preview-user-tags')).toContainText('alpha');
  await expect(input).toBeFocused();
  await page.keyboard.type('beta');
  await page.keyboard.press('Enter');
  await expect(page.locator('#preview-user-tags')).toContainText('beta');
  await expect(input).toBeFocused();
  expect(fixture.tagRequests).toEqual([
    {id: 'preview-a', tags: ['alpha']},
    {id: 'preview-a', tags: ['alpha', 'beta']},
  ]);

  await input.fill('');
  await page.keyboard.type('q');
  await expect(input).toHaveValue('q');
  await expect(modal).toBeVisible();

  await input.evaluate(element => element.blur());
  await page.keyboard.press('Tab');
  await expect(modal).toHaveClass(/preview-focus-mode/);
  await expect(inspector).not.toBeVisible();
  await page.keyboard.press('t');
  await expect(modal).toHaveClass(/preview-focus-mode/);
  await expect(inspector).toBeVisible();
  await expect(input).toBeFocused();
});

test('Q closes Viewer and Settings as an Escape alias', async ({page}) => {
  await installPreviewFixture(page);
  await openFixture(page);

  await page.locator('#settings-toggle').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.keyboard.press('q');
  await expect(page.locator('#settings-panel')).not.toBeVisible();

  await page.locator('.card[data-id="preview-a"]').click();
  await expect(page.locator('#preview-modal')).toBeVisible();
  await page.keyboard.press('q');
  await expect(page.locator('#preview-modal')).not.toBeVisible();
});

test('removing Graph preserves Settings, gallery controls, and responsive filter geometry', async ({page}) => {
  const pageErrors: Error[] = [];
  const imageRequests: string[] = [];
  page.on('pageerror', error => pageErrors.push(error));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/images') imageRequests.push(request.url());
  });

  await installPreviewFixture(page);
  await page.setViewportSize({width: 1366, height: 768});
  await openFixture(page);

  await expect(page.locator('[data-action="open-graph"]')).toHaveCount(0);
  await expect(page.locator('[data-settings-tab="graph"]')).toHaveCount(0);
  await expect(page.locator('#graph-overlay, #graph-canvas')).toHaveCount(0);

  const filterLayout = async () => page.locator('#filter-bar .filter-head').evaluate(element => {
    const container = element.getBoundingClientRect();
    const children = [...element.children].map(child => child.getBoundingClientRect());
    return {
      childCount: children.length,
      columnCount: getComputedStyle(element).gridTemplateColumns.split(' ').length,
      rowCount: new Set(children.map(rect => Math.round(rect.top))).size,
      overflows: element.scrollWidth > element.clientWidth + 1
        || children.some(rect => rect.left < container.left - 1 || rect.right > container.right + 1),
    };
  });
  expect(await filterLayout()).toEqual({childCount: 4, columnCount: 4, rowCount: 1, overflows: false});

  await page.locator('#settings-toggle').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await expect(page.locator('.settings-tab')).toHaveText(['Общее', 'Теги', /Проблемы/]);
  await page.keyboard.press('q');
  await expect(page.locator('#settings-panel')).not.toBeVisible();

  await page.locator('#sort-select').selectOption('path_asc');
  await expect.poll(() => imageRequests.some(url => new URL(url).searchParams.get('sort') === 'path_asc')).toBe(true);
  await page.locator('#filter-tag-input').fill('hiking');
  await page.locator('#filter-tag-input').press('Enter');
  await expect(page.locator('#selected-filter-tags')).toContainText('hiking');
  await expect.poll(() => imageRequests.some(url => new URL(url).searchParams.get('include_tags') === 'hiking')).toBe(true);

  await page.locator('.card[data-id="preview-a"]').click();
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'preview-a');
  await page.keyboard.press('q');
  await expect(page.locator('#preview-modal')).not.toBeVisible();

  await page.setViewportSize({width: 720, height: 900});
  await expect.poll(filterLayout).toEqual({childCount: 4, columnCount: 2, rowCount: 3, overflows: false});
  expect(pageErrors).toEqual([]);
});

test('application tab shortcuts create close and select tabs even from text input', async ({page}) => {
  await installPreviewFixture(page);
  await openFixture(page);

  const tabs = page.locator('#tabs .tab[data-tab]');
  const activeTab = page.locator('#tabs .tab.active[data-tab]');
  await expect(tabs).toHaveCount(1);
  const firstId = await activeTab.getAttribute('data-tab');

  await page.locator('#filter-tag-input').focus();
  await page.keyboard.press('Control+t');
  await expect(tabs).toHaveCount(2);
  const secondId = await activeTab.getAttribute('data-tab');
  expect(secondId).not.toBe(firstId);

  await page.locator('#filter-tag-input').focus();
  await page.keyboard.press('Control+t');
  await expect(tabs).toHaveCount(3);
  const thirdId = await activeTab.getAttribute('data-tab');
  expect(thirdId).not.toBe(secondId);

  await page.locator('#filter-tag-input').focus();
  await page.keyboard.press('Alt+Digit1');
  await expect(activeTab).toHaveAttribute('data-tab', firstId || '');
  await page.keyboard.press('Alt+Digit2');
  await expect(activeTab).toHaveAttribute('data-tab', secondId || '');
  await page.keyboard.press('Alt+Digit3');
  await expect(activeTab).toHaveAttribute('data-tab', thirdId || '');
  await page.keyboard.press('Alt+Digit9');
  await expect(activeTab).toHaveAttribute('data-tab', thirdId || '');

  await page.locator('#filter-tag-input').focus();
  await page.keyboard.press('Control+w');
  await expect(tabs).toHaveCount(2);
  await expect(activeTab).toHaveAttribute('data-tab', secondId || '');
  await page.keyboard.press('Control+w');
  await expect(tabs).toHaveCount(1);
  await page.keyboard.press('Control+w');
  await expect(tabs).toHaveCount(1);
  await expect(page.locator('#gallery-screen')).toBeVisible();
  await expect(page.locator('.card[data-id="preview-a"]')).toBeVisible();
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
  await page.keyboard.press('q');
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

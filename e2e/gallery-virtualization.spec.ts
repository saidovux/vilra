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
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({status: 200, json: {ok: true}});
    return route.fulfill({status: 200, json: {
      root_path: '/synthetic-fixture',
      root_paths: ['/synthetic-fixture'],
      search_tags: [],
      search_mode: 'any',
      tabs: [],
      active_tab_id: null,
      last_image_id: null,
      scroll_top: 0,
      folder_tag_sync: true,
    }});
  });
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

async function visibleGalleryAnchor(page: Page) {
  return page.locator('.virtual-card-slot[data-id]').evaluateAll(slots => {
    const candidates = slots
      .map(slot => ({id: String((slot as HTMLElement).dataset.id || ''), rect: slot.getBoundingClientRect()}))
      .filter(item => item.rect.bottom > 0 && item.rect.top < innerHeight)
      .sort((left, right) => Math.abs(left.rect.top) - Math.abs(right.rect.top));
    return candidates[0] ? {id: candidates[0].id, top: candidates[0].rect.top} : null;
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

test('Gallery j and k scroll natively while modified variants stay unhandled', async ({page}) => {
  await installSyntheticGallery(page);
  await page.setViewportSize({width: 1366, height: 768});
  await page.goto('/');
  await page.locator('html').evaluate(element => { element.style.scrollBehavior = 'auto'; });
  await expect(page.locator('.card[data-id]').first()).toBeVisible();
  await page.evaluate(() => {
    window.scrollTo({top: 1200});
    (document.activeElement as HTMLElement | null)?.blur();
  });
  const beforeDown = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('j');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeDown);
  const beforeUp = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('k');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(beforeUp);

  const beforeModifiedKeys = await page.evaluate(() => window.scrollY);
  await page.locator('body').dispatchEvent('keydown', {key: 'j', ctrlKey: true, bubbles: true, cancelable: true});
  await page.locator('body').dispatchEvent('keydown', {key: 'j', altKey: true, bubbles: true, cancelable: true});
  await page.locator('body').dispatchEvent('keydown', {key: 'j', metaKey: true, bubbles: true, cancelable: true});
  await page.locator('body').dispatchEvent('keydown', {key: 'J', shiftKey: true, bubbles: true, cancelable: true});
  expect(await page.evaluate(() => window.scrollY)).toBe(beforeModifiedKeys);
});

test('explicit Gallery Focus and sidebar controls preserve the visible virtual anchor', async ({page}) => {
  await installSyntheticGallery(page);
  await page.setViewportSize({width: 1366, height: 768});
  await page.goto('/');
  await page.locator('html').evaluate(element => { element.style.scrollBehavior = 'auto'; });
  await expect(page.locator('.card[data-id]').first()).toBeVisible();
  await expect(page.locator('#gallery-focus-toggle')).toContainText('Focus');
  await expect(page.locator('#gallery-focus-toggle')).toContainText('Tab');

  await page.evaluate(() => window.scrollTo({top: 1200}));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  await expect(page.locator('#topbar')).toBeVisible();
  await expect(page.locator('#filter-bar')).toBeVisible();
  await expect(page.locator('#folder-sidebar')).toBeVisible();
  await expect(page.locator('body')).not.toHaveClass(/chrome-hidden/);
  const beforeFocus = await visibleGalleryAnchor(page);
  expect(beforeFocus).toBeTruthy();

  await page.keyboard.press('Tab');
  await expect(page.locator('#gallery-screen')).toHaveClass(/gallery-focus-mode/);
  await expect(page.locator('#topbar')).not.toBeVisible();
  await expect(page.locator('#filter-bar')).not.toBeVisible();
  await expect(page.locator('#folder-sidebar')).toHaveClass(/collapsed/);
  const focusedWrap = await page.locator('#gallery-wrap').boundingBox();
  expect(focusedWrap).toBeTruthy();
  expect(Math.abs(focusedWrap!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusedWrap!.width - 1366)).toBeLessThanOrEqual(1);
  const anchorSlot = page.locator(`.virtual-card-slot[data-id="${beforeFocus!.id}"]`);
  await expect(anchorSlot).toHaveCount(1);
  await expect.poll(async () => {
    const box = await anchorSlot.boundingBox();
    return Math.abs((box?.y ?? Number.POSITIVE_INFINITY) - beforeFocus!.top);
  }).toBeLessThanOrEqual(3);
  const beforeFocusExit = await visibleGalleryAnchor(page);
  expect(beforeFocusExit).toBeTruthy();

  await page.keyboard.press('Tab');
  await expect(page.locator('#gallery-screen')).not.toHaveClass(/gallery-focus-mode/);
  await expect(page.locator('#topbar')).toBeVisible();
  await expect(page.locator('#filter-bar')).toBeVisible();
  await expect(page.locator('#folder-sidebar')).not.toHaveClass(/collapsed/);
  const focusExitAnchorSlot = page.locator(`.virtual-card-slot[data-id="${beforeFocusExit!.id}"]`);
  await expect.poll(async () => {
    const box = await focusExitAnchorSlot.boundingBox();
    return Math.abs((box?.y ?? Number.POSITIVE_INFINITY) - beforeFocusExit!.top);
  }).toBeLessThanOrEqual(3);

  await page.keyboard.press('Control+b');
  await expect(page.locator('#folder-sidebar')).toHaveClass(/collapsed/);
  await expect(page.locator('#topbar')).toBeVisible();
  await expect(page.locator('#filter-bar')).toBeVisible();
  const hiddenSidebarWrap = await page.locator('#gallery-wrap').boundingBox();
  expect(hiddenSidebarWrap).toBeTruthy();
  expect(Math.abs(hiddenSidebarWrap!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(hiddenSidebarWrap!.width - 1366)).toBeLessThanOrEqual(1);

  await page.keyboard.press('Tab');
  await expect(page.locator('#gallery-screen')).toHaveClass(/gallery-focus-mode/);
  await expect(page.locator('#folder-sidebar')).toHaveClass(/collapsed/);
  await page.keyboard.press('Control+b');
  await expect(page.locator('#folder-sidebar')).not.toHaveClass(/collapsed/);
  await expect(page.locator('#topbar')).not.toBeVisible();
  await expect(page.locator('#filter-bar')).not.toBeVisible();
  const focusSidebar = await page.locator('#folder-sidebar').boundingBox();
  const focusSidebarWrap = await page.locator('#gallery-wrap').boundingBox();
  expect(focusSidebar).toBeTruthy();
  expect(focusSidebarWrap).toBeTruthy();
  expect(Math.abs(focusSidebar!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusSidebar!.height - 768)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusSidebarWrap!.x - 276)).toBeLessThanOrEqual(1);
  expect(Math.abs(focusSidebarWrap!.width - (1366 - 276))).toBeLessThanOrEqual(1);

  await page.keyboard.press('Tab');
  await expect(page.locator('#gallery-screen')).not.toHaveClass(/gallery-focus-mode/);
  await expect(page.locator('#folder-sidebar')).not.toHaveClass(/collapsed/);
  await expect(page.locator('#topbar')).toBeVisible();
  await expect(page.locator('#filter-bar')).toBeVisible();
});

test('Chromium thumbnail becomes visible only after current decode and stays ready on hover', async ({page}) => {
  const targetId = 'synthetic-00000';
  let targetRequests = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === `/thumb-file/${targetId}.jpg`) targetRequests += 1;
  });
  await page.addInitScript(imageId => {
    const originalDecode = HTMLImageElement.prototype.decode;
    const pending: Array<() => void> = [];
    const control = {
      calls: 0,
      enabled: true,
      pending: () => pending.length,
      releaseNext: () => pending.shift()?.(),
      disable: () => { control.enabled = false; },
    };
    (window as unknown as {__thumbnailDecodeControl: typeof control}).__thumbnailDecodeControl = control;
    HTMLImageElement.prototype.decode = function(): Promise<void> {
      if (this.dataset.imageId !== imageId) return originalDecode.call(this);
      control.calls += 1;
      if (!control.enabled) return originalDecode.call(this);
      const image = this;
      return new Promise<void>((resolve, reject) => {
        pending.push(() => { void originalDecode.call(image).then(resolve, reject); });
      });
    };
  }, targetId);
  await installSyntheticGallery(page);
  await page.setViewportSize({width: 1366, height: 768});
  await page.goto('/');
  await page.locator('html').evaluate(element => { element.style.scrollBehavior = 'auto'; });

  const targetSlot = page.locator(`.virtual-card-slot[data-id="${targetId}"]`);
  const targetCard = targetSlot.locator('.card');
  const targetImage = targetCard.locator('img');
  const decodeState = () => page.evaluate(() => {
    const control = (window as unknown as {__thumbnailDecodeControl: {
      calls: number;
      pending: () => number;
    }}).__thumbnailDecodeControl;
    return {calls: control.calls, pending: control.pending()};
  });
  const releaseDecode = () => page.evaluate(() => {
    (window as unknown as {__thumbnailDecodeControl: {releaseNext: () => void}})
      .__thumbnailDecodeControl.releaseNext();
  });

  await expect.poll(decodeState).toEqual({calls: 1, pending: 1});
  await expect.poll(() => targetImage.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(targetImage).not.toHaveClass(/loaded/);
  await expect(targetImage).toHaveCSS('opacity', '0');
  const staleImage = await targetImage.elementHandle();
  expect(staleImage).toBeTruthy();

  await page.evaluate(() => window.scrollTo({top: 12_000}));
  await expect(targetSlot).toHaveCount(0);
  await releaseDecode();
  await expect.poll(async () => (await decodeState()).pending).toBe(0);
  expect(await staleImage!.evaluate(image => ({
    connected: image.isConnected,
    loaded: image.classList.contains('loaded'),
  }))).toEqual({connected: false, loaded: false});

  await page.evaluate(() => window.scrollTo({top: 0}));
  await expect.poll(decodeState).toEqual({calls: 2, pending: 1});
  await releaseDecode();
  await expect(targetImage).toHaveClass(/loaded/);
  await page.evaluate(() => {
    (window as unknown as {__thumbnailDecodeControl: {disable: () => void}})
      .__thumbnailDecodeControl.disable();
  });
  expect(await targetImage.evaluate(image => image.decode().then(() => true))).toBe(true);

  const assertPaintReady = async () => {
    const state = await targetImage.evaluate(image => {
      const slot = image.closest<HTMLElement>('.virtual-card-slot');
      const style = getComputedStyle(image);
      return {
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        loaded: image.classList.contains('loaded'),
        opacity: style.opacity,
        display: style.display,
        visibility: style.visibility,
        slotWillChange: slot ? getComputedStyle(slot).willChange : '',
        slotTransform: slot?.style.transform || '',
        source: image.currentSrc,
      };
    });
    expect(state).toMatchObject({
      complete: true,
      loaded: true,
      opacity: '1',
      display: 'block',
      visibility: 'visible',
      slotWillChange: 'auto',
    });
    expect(state.naturalWidth).toBeGreaterThan(0);
    expect(state.slotTransform).toMatch(/^translate\(/);
    expect(state.source).toContain(`/thumb-file/${targetId}.jpg`);
    return state.source;
  };

  const assertHoverDoesNotReload = async () => {
    await targetImage.evaluate(image => {
      image.dataset.hoverProbeLoads = '0';
      image.addEventListener('load', () => {
        image.dataset.hoverProbeLoads = String(Number(image.dataset.hoverProbeLoads || 0) + 1);
      });
    });
    const requestsBeforeHover = targetRequests;
    const decodeCallsBeforeHover = (await decodeState()).calls;
    const sourceBeforeHover = await assertPaintReady();
    const transformBeforeHover = await targetSlot.evaluate(slot => slot.style.transform);
    await targetSlot.evaluate(slot => {
      const state = {mutations: 0, observer: null as MutationObserver | null};
      state.observer = new MutationObserver(records => { state.mutations += records.length; });
      state.observer.observe(slot, {attributes: true, childList: true, subtree: true});
      (window as unknown as {__thumbnailHoverState: typeof state}).__thumbnailHoverState = state;
    });
    await targetCard.hover();
    await page.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    const mutations = await page.evaluate(() => {
      const state = (window as unknown as {__thumbnailHoverState: {
        mutations: number;
        observer: MutationObserver;
      }}).__thumbnailHoverState;
      state.observer.disconnect();
      return state.mutations;
    });
    expect(await targetImage.getAttribute('data-hover-probe-loads')).toBe('0');
    expect(targetRequests).toBe(requestsBeforeHover);
    expect((await decodeState()).calls).toBe(decodeCallsBeforeHover);
    expect(mutations).toBe(0);
    expect(await targetSlot.evaluate(slot => slot.style.transform)).toBe(transformBeforeHover);
    expect(await assertPaintReady()).toBe(sourceBeforeHover);
  };

  await assertHoverDoesNotReload();
});

test('TanStack virtual masonry stays bounded through pagination, reverse scroll, and resize', async ({page}, testInfo) => {
  test.setTimeout(180_000);
  const state = await installSyntheticGallery(page);
  await page.setViewportSize({width: 1366, height: 768});
  await page.goto('/');
  await page.locator('html').evaluate(element => { element.style.scrollBehavior = 'auto'; });
  await expect(page.locator('#gallery-screen')).toBeVisible();
  await expect(page.locator('.card[data-id]').first()).toBeVisible();
  await expect(page.locator('#count-text')).toContainText(String(TOTAL_IMAGES));
  await page.locator('#folder-sidebar-toggle').click();
  await expect(page.locator('#folder-sidebar')).toHaveClass(/collapsed/);

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

  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight * 0.7}));
  await page.waitForTimeout(40);
  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight * 0.85}));
  await page.waitForTimeout(40);
  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight * 0.5}));
  await page.waitForTimeout(40);
  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight * 0.8}));
  await expect.poll(() => page.locator('.card img').evaluateAll(images => images.filter(image => {
    const rect = image.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && !image.classList.contains('loaded');
  }).length)).toBe(0);
  const directionReversal = await gallerySnapshot(page);
  expect(directionReversal.cards).toBeLessThanOrEqual(DOM_CARD_LIMIT);

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
    body: Buffer.from(JSON.stringify({
      initial,
      deepest,
      returned,
      reversed,
      directionReversal,
      beforeResize,
      afterResize,
      deepGeometryDrift,
    }, null, 2)),
  });
});

test('stale cursor page cannot append after sort generation changes', async ({page}) => {
  let releaseOldPage: () => void = () => undefined;
  let markOldPageStarted: () => void = () => undefined;
  const oldPageGate = new Promise<void>(resolve => { releaseOldPage = resolve; });
  const oldPageStarted = new Promise<void>(resolve => { markOldPageStarted = resolve; });

  await page.route('**/api/events', route => route.abort());
  await page.route('**/api/session', async route => {
    if (route.request().method() !== 'GET') return route.fulfill({status: 200, json: {ok: true}});
    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({response, json: {
      ...payload,
      tabs: [],
      active_tab_id: null,
      search_tags: [],
      search_mode: 'any',
      last_image_id: null,
    }});
  });
  await page.route('**/api/images?**', async route => {
    const url = new URL(route.request().url());
    const sort = url.searchParams.get('sort') || 'date_desc';
    const cursor = url.searchParams.get('cursor');
    if (sort === 'date_desc' && cursor) {
      markOldPageStarted();
      await oldPageGate;
      return route.fulfill({json: {
        items: Array.from({length: PAGE_SIZE}, (_, index) => ({
          ...syntheticImage(PAGE_SIZE + index),
          id: `stale-a-${index}`,
          thumb_url: `/thumb-file/stale-a-${index}.jpg`,
        })),
        page: {total: null, next_cursor: null, has_more: false},
      }});
    }
    const prefix = sort === 'path_asc' ? 'fresh-b' : 'initial-a';
    return route.fulfill({json: {
      items: Array.from({length: PAGE_SIZE}, (_, index) => ({
        ...syntheticImage(index),
        id: `${prefix}-${index}`,
        thumb_url: `/thumb-file/${prefix}-${index}.jpg`,
      })),
      page: {
        total: PAGE_SIZE,
        next_cursor: sort === 'path_asc' ? null : String(PAGE_SIZE),
        has_more: sort !== 'path_asc',
      },
    }});
  });
  await page.route('**/thumb-file/**', route => route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL}));

  await page.goto('/');
  await expect(page.locator('.card[data-id^="initial-a-"]').first()).toBeVisible();
  await oldPageStarted;
  await page.locator('#sort-select').selectOption('path_asc');
  await expect(page.locator('.card[data-id^="fresh-b-"]').first()).toBeVisible();

  releaseOldPage();
  await page.waitForTimeout(150);
  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight}));
  await page.waitForTimeout(100);
  await expect(page.locator('.card[data-id^="stale-a-"]')).toHaveCount(0);
  await expect(page.locator('.card[data-id^="fresh-b-"]')).not.toHaveCount(0);
});

test('completed slow cursor page can trigger the next page while user remains near the end', async ({page}) => {
  let releaseSlowPage: () => void = () => undefined;
  let markSlowPageStarted: () => void = () => undefined;
  const slowPageGate = new Promise<void>(resolve => { releaseSlowPage = resolve; });
  const slowPageStarted = new Promise<void>(resolve => { markSlowPageStarted = resolve; });
  const requestedOffsets: number[] = [];

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
  await page.route('**/api/images?**', async route => {
    const url = new URL(route.request().url());
    const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
    requestedOffsets.push(offset);
    if (offset === PAGE_SIZE) {
      markSlowPageStarted();
      await slowPageGate;
    }
    const end = Math.min(PAGE_SIZE * 3, offset + PAGE_SIZE);
    return route.fulfill({json: {
      items: Array.from({length: end - offset}, (_, index) => syntheticImage(offset + index)),
      page: {
        total: offset === 0 ? PAGE_SIZE * 3 : null,
        next_cursor: end < PAGE_SIZE * 3 ? String(end) : null,
        has_more: end < PAGE_SIZE * 3,
      },
    }});
  });
  await page.route('**/thumb-file/**', route => route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL}));

  await page.goto('/');
  await expect(page.locator('.card[data-id]').first()).toBeVisible();
  await slowPageStarted;
  await page.evaluate(() => window.scrollTo({top: document.documentElement.scrollHeight}));
  releaseSlowPage();

  await expect.poll(() => requestedOffsets.includes(PAGE_SIZE * 2)).toBe(true);
  expect(requestedOffsets.filter(offset => offset === PAGE_SIZE)).toHaveLength(1);
  expect(requestedOffsets.filter(offset => offset === PAGE_SIZE * 2)).toHaveLength(1);
});

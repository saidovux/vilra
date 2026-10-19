import {expect, test, type Page} from '@playwright/test';

const THUMBNAIL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

type LiveImage = {
  id: string;
  path: string;
  thumb_url: string;
  width: number;
  height: number;
  size: number;
  mtime: number;
  tags: string[];
  auto_tags: string[];
  folder_tags: string[];
  user_tags: string[];
};

type LiveFixtureState = {
  images: LiveImage[];
  sequence: number;
  countRequests: number;
  countQueries: string[];
  galleryRequests: number;
  tagRequests: number;
  holdNextCount: boolean;
  releaseHeldCount: (() => void) | null;
};

function liveImage(index: number): LiveImage {
  const tags = index < 50 ? ['red'] : ['blue'];
  const id = `live-${String(index).padStart(3, '0')}`;
  return {
    id,
    path: `library/image-${String(index).padStart(3, '0')}.jpg`,
    thumb_url: `/thumb-file/${id}.jpg`,
    width: 640,
    height: 480,
    size: 10_000 + index,
    mtime: 1_000 - index,
    tags: tags.slice(),
    auto_tags: tags.slice(),
    folder_tags: tags.slice(),
    user_tags: [],
  };
}

function tagList(value: string | null): string[] {
  return String(value || '')
    .split(',')
    .map(tag => tag.trim().toLowerCase())
    .filter(Boolean);
}

function matchingImages(images: LiveImage[], url: URL): LiveImage[] {
  const include = tagList(url.searchParams.get('include_tags'));
  const exclude = tagList(url.searchParams.get('exclude_tags'));
  const matchAll = url.searchParams.get('match_mode') === 'all';
  return images
    .filter(image => {
      const tags = new Set(image.tags.map(tag => tag.toLowerCase()));
      if (exclude.some(tag => tags.has(tag))) return false;
      if (!include.length) return true;
      return matchAll ? include.every(tag => tags.has(tag)) : include.some(tag => tags.has(tag));
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

async function installLiveFilteredFixture(page: Page): Promise<LiveFixtureState> {
  const state: LiveFixtureState = {
    images: Array.from({length: 60}, (_, index) => liveImage(index)),
    sequence: 0,
    countRequests: 0,
    countQueries: [],
    galleryRequests: 0,
    tagRequests: 0,
    holdNextCount: false,
    releaseHeldCount: null,
  };

  await page.addInitScript(() => {
    type LiveEmitterWindow = Window & {__emitVilraLiveEvent?: (payload: unknown) => void};
    let activeSource: TestEventSource | null = null;
    class TestEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(_url: string) {
        activeSource = this;
      }

      close(): void {
        if (activeSource === this) activeSource = null;
      }
    }
    Object.defineProperty(window, 'EventSource', {configurable: true, value: TestEventSource});
    (window as LiveEmitterWindow).__emitVilraLiveEvent = payload => {
      activeSource?.onmessage?.(new MessageEvent('message', {data: JSON.stringify(payload)}));
    };
  });

  await page.route('**/api/session', route => {
    if (route.request().method() !== 'GET') return route.fulfill({status: 200, json: {ok: true}});
    return route.fulfill({status: 200, json: {
      root_path: '/live-filter-fixture',
      root_paths: ['/live-filter-fixture'],
      tabs: [{
        id: 'filtered',
        title: 'Red',
        includeTags: ['red'],
        excludeTags: [],
        matchMode: 'any',
        sortMode: 'path_asc',
        lastImageId: null,
        scrollTop: 0,
      }],
      active_tab_id: 'filtered',
      search_tags: ['red'],
      search_mode: 'any',
      last_image_id: null,
      folder_tag_sync: true,
    }});
  });
  await page.route('**/api/images?**', async route => {
    const url = new URL(route.request().url());
    const matches = matchingImages(state.images, url);
    const limit = Math.max(1, Number(url.searchParams.get('limit')) || 48);
    const offset = Math.max(0, Number(url.searchParams.get('cursor')) || 0);
    const total = matches.length;
    const isCount = limit === 1 && url.searchParams.get('include_total') === '1';
    if (isCount) {
      state.countRequests += 1;
      state.countQueries.push(url.search);
      if (state.holdNextCount) {
        state.holdNextCount = false;
        await new Promise<void>(resolve => {
          state.releaseHeldCount = resolve;
        });
        state.releaseHeldCount = null;
      }
    } else {
      state.galleryRequests += 1;
    }
    const items = matches.slice(offset, offset + limit);
    const end = offset + items.length;
    return route.fulfill({status: 200, json: {
      items,
      page: {
        total: url.searchParams.get('include_total') === '1' ? total : null,
        next_cursor: end < total ? String(end) : null,
        has_more: end < total,
      },
    }});
  });
  await page.route('**/api/tags', route => {
    state.tagRequests += 1;
    const red = state.images.filter(image => image.tags.includes('red')).length;
    const blue = state.images.filter(image => image.tags.includes('blue')).length;
    return route.fulfill({status: 200, json: {tags: [
      {name: 'red', normalized: 'red', image_count: red, auto_count: red, user_count: 0, user_defined: false, is_auto: true, source: 'auto', sources: ['auto']},
      {name: 'blue', normalized: 'blue', image_count: blue, auto_count: blue, user_count: 0, user_defined: false, is_auto: true, source: 'auto', sources: ['auto']},
    ]}});
  });
  await page.route('**/api/folders', route => route.fulfill({status: 200, json: {roots: ['/live-filter-fixture']}}));
  await page.route('**/api/status', route => route.fulfill({status: 200, json: {
    db_ready: true,
    root: '/live-filter-fixture',
    root_paths: ['/live-filter-fixture'],
    running: false,
    queued: false,
  }}));
  await page.route('**/thumb-file/**', route => route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL}));
  await page.route('**/thumb/**', route => route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL}));
  await page.route('**/file/live-*', route => route.fulfill({status: 200, contentType: 'image/png', body: THUMBNAIL}));
  return state;
}

async function openFilteredGallery(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#gallery-screen')).toBeVisible();
  await expect(page.locator('#count-text')).toHaveText('50 фото');
  await expect(page.locator('.card[data-id="live-000"]')).toBeVisible();
}

async function emitLiveImage(page: Page, state: LiveFixtureState, type: string, image: LiveImage): Promise<void> {
  state.sequence += 1;
  await page.evaluate(event => {
    const emit = (window as Window & {__emitVilraLiveEvent?: (payload: unknown) => void}).__emitVilraLiveEvent;
    if (!emit) throw new Error('live event fixture is not installed');
    emit(event);
  }, {sequence: state.sequence, type, data: {image, image_id: image.id}});
}

function replaceTags(image: LiveImage, tags: string[], path = image.path): LiveImage {
  return {
    ...image,
    path,
    tags: tags.slice(),
    auto_tags: tags.slice(),
    folder_tags: tags.slice(),
    mtime: image.mtime + 1,
  };
}

test('live rename leaving and re-entering the active filter converges to canonical total', async ({page}) => {
  const state = await installLiveFilteredFixture(page);
  await openFilteredGallery(page);
  const original = state.images[0];
  const outside = replaceTags(original, [], 'outside/image-000.jpg');
  state.images[0] = outside;

  await emitLiveImage(page, state, 'image_renamed', outside);
  await expect(page.locator('.card[data-id="live-000"]')).toHaveCount(0);
  await expect(page.locator('#count-text')).toHaveText('49 фото');
  expect(state.countRequests).toBe(1);

  const restored = replaceTags(outside, ['red'], original.path);
  state.images[0] = restored;
  await emitLiveImage(page, state, 'image_renamed', restored);

  await expect(page.locator('.card[data-id="live-000"]')).toBeVisible();
  await expect(page.locator('#count-text')).toHaveText('50 фото');
  expect(state.countRequests).toBe(2);
});

test('repeated updates with stable loaded membership do not count or inflate total', async ({page}) => {
  const state = await installLiveFilteredFixture(page);
  await openFilteredGallery(page);
  const baselineTags = state.tagRequests;
  let updated = replaceTags(state.images[1], ['red'], 'library/image-001-a.jpg');
  state.images[1] = updated;

  await emitLiveImage(page, state, 'image_updated', updated);
  await expect(page.locator('.card[data-id="live-001"] .card-name')).toHaveText('image-001-a.jpg');
  await expect.poll(() => state.tagRequests).toBeGreaterThan(baselineTags);

  const firstTagRefresh = state.tagRequests;
  updated = replaceTags(updated, ['red'], 'library/image-001-b.jpg');
  state.images[1] = updated;
  await emitLiveImage(page, state, 'image_updated', updated);
  await expect(page.locator('.card[data-id="live-001"] .card-name')).toHaveText('image-001-b.jpg');
  await expect.poll(() => state.tagRequests).toBeGreaterThan(firstTagRefresh);

  expect(state.countRequests).toBe(0);
  await expect(page.locator('#count-text')).toHaveText('50 фото');
});

test('live update refreshes metadata for the image currently open in Viewer', async ({page}) => {
  const state = await installLiveFilteredFixture(page);
  await openFilteredGallery(page);
  await page.locator('.card[data-id="live-000"]').click();
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'live-000');
  await expect(page.locator('#preview-name')).toHaveText('image-000.jpg');

  const current = state.images[0];
  const updated = {
    ...current,
    path: 'library/live-updated-name.jpg',
    width: 900,
    height: 300,
    mtime: current.mtime + 1,
  };
  state.images[0] = updated;
  await emitLiveImage(page, state, 'image_updated', updated);

  await expect(page.locator('#preview-name')).toHaveText('live-updated-name.jpg');
  await expect(page.locator('#preview-resolution')).toHaveText('900 × 300');
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'live-000');
});

test('live removal of the current image closes Viewer without restoring its Gallery anchor', async ({page}) => {
  const state = await installLiveFilteredFixture(page);
  await openFilteredGallery(page);
  const removed = state.images[0];
  await page.locator('.card[data-id="live-000"]').click();
  await expect(page.locator('#preview-modal')).toHaveAttribute('data-image-id', 'live-000');
  state.images = state.images.filter(image => image.id !== removed.id);

  await emitLiveImage(page, state, 'image_removed', removed);

  await expect(page.locator('#preview-modal')).not.toBeVisible();
  await expect(page.locator('.card[data-id="live-000"]')).toHaveCount(0);
});

test('removing an unloaded matching image uses canonical total instead of loaded membership', async ({page}) => {
  const state = await installLiveFilteredFixture(page);
  await openFilteredGallery(page);
  const removed = state.images.find(image => image.id === 'live-049');
  expect(removed).toBeTruthy();
  await expect(page.locator('.card[data-id="live-049"]')).toHaveCount(0);
  state.images = state.images.filter(image => image.id !== removed?.id);

  await emitLiveImage(page, state, 'image_removed', removed!);

  await expect(page.locator('#count-text')).toHaveText('49 фото');
  expect(state.countRequests).toBe(1);
});

test('stale delayed count cannot overwrite a new tab and live changes trigger one rerun', async ({page}) => {
  const state = await installLiveFilteredFixture(page);
  await openFilteredGallery(page);
  state.holdNextCount = true;
  const first = state.images.find(image => image.id === 'live-049')!;
  const firstOutside = replaceTags(first, []);
  state.images[state.images.indexOf(first)] = firstOutside;

  await emitLiveImage(page, state, 'image_updated', firstOutside);
  await expect.poll(() => state.countRequests).toBe(1);
  expect(state.releaseHeldCount).not.toBeNull();

  const second = state.images.find(image => image.id === 'live-048')!;
  const secondOutside = replaceTags(second, []);
  state.images[state.images.indexOf(second)] = secondOutside;
  await emitLiveImage(page, state, 'image_updated', secondOutside);

  await page.keyboard.press('Control+t');
  await expect(page.locator('#tabs .tab[data-tab]')).toHaveCount(2);
  await expect(page.locator('#count-text')).toHaveText('60 фото');

  state.releaseHeldCount?.();
  await expect.poll(() => state.countRequests).toBe(2);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));

  await expect(page.locator('#count-text')).toHaveText('60 фото');
  expect(state.countQueries).toHaveLength(2);
  expect(state.countQueries[0]).toContain('include_tags=red');
  expect(state.countQueries[1]).not.toContain('include_tags=red');
});

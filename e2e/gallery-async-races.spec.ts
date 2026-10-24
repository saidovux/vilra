import {expect, test, type Page, type Route} from '@playwright/test';

const THUMBNAIL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

type RaceImage = {
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

type FixtureOptions = {
  session?: Record<string, unknown>;
  handleImages(route: Route, url: URL): Promise<void> | void;
  handleTags?(route: Route, requestNumber: number): Promise<void> | void;
  handleTagMutation?(route: Route): Promise<void> | void;
};

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

function raceImage(id: string, tag: string, index = 0): RaceImage {
  return {
    id,
    path: `${tag}/${id}.jpg`,
    thumb_url: `/thumb-file/${id}.jpg`,
    width: 640,
    height: 480,
    size: 10_000 + index,
    mtime: 1_000 - index,
    tags: [tag],
    auto_tags: [tag],
    folder_tags: [tag],
    user_tags: [],
  };
}

function tagMeta(name: string) {
  return {
    name,
    normalized: name,
    color: null,
    image_count: 1,
    auto_count: 0,
    user_count: 1,
    user_defined: true,
    is_auto: false,
    source: 'user',
    sources: ['user'],
  };
}

function galleryTab(id: string, tag: string, scrollTop = 0) {
  return {
    id,
    title: tag.toUpperCase(),
    includeTags: [tag],
    excludeTags: [],
    matchMode: 'any',
    sortMode: 'date_desc',
    lastImageId: null,
    scrollTop,
  };
}

async function installRaceFixture(page: Page, options: FixtureOptions): Promise<void> {
  await page.addInitScript(() => {
    type RaceWindow = Window & {__emitVilraRaceEvent?: (payload: unknown) => void};
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
    (window as RaceWindow).__emitVilraRaceEvent = payload => {
      activeSource?.onmessage?.(new MessageEvent('message', {data: JSON.stringify(payload)}));
    };
  });

  const session = options.session || {
    root_path: '/race-fixture',
    root_paths: ['/race-fixture'],
    tabs: [galleryTab('tab-a', 'a')],
    active_tab_id: 'tab-a',
    search_tags: ['a'],
    search_mode: 'any',
    last_image_id: null,
    folder_tag_sync: true,
  };
  let tagRequestNumber = 0;

  await page.route('**/api/session', route => {
    if (route.request().method() === 'GET') return route.fulfill({status: 200, json: session});
    return route.fulfill({status: 200, json: {ok: true}});
  });
  await page.route('**/api/images?**', route => options.handleImages(
    route,
    new URL(route.request().url()),
  ));
  await page.route('**/api/tags', route => {
    if (route.request().method() !== 'GET') {
      if (options.handleTagMutation) return options.handleTagMutation(route);
      return route.fulfill({status: 200, json: {tags: [tagMeta('base')]}});
    }
    tagRequestNumber += 1;
    if (options.handleTags) return options.handleTags(route, tagRequestNumber);
    return route.fulfill({status: 200, json: {tags: [tagMeta('base')]}});
  });
  await page.route('**/api/folders', route => route.fulfill({
    status: 200,
    json: {roots: ['/race-fixture']},
  }));
  await page.route('**/api/status', route => route.fulfill({status: 200, json: {
    db_ready: true,
    root: '/race-fixture',
    root_paths: ['/race-fixture'],
    running: false,
    queued: false,
  }}));
  await page.route('**/api/problems/summary', route => route.fulfill({status: 200, json: {
    total: 0,
    errors: 0,
    warnings: 0,
  }}));
  await page.route('**/api/problems?**', route => route.fulfill({status: 200, json: {
    items: [],
    page: {total: 0},
  }}));
  await page.route('**/thumb-file/**', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: THUMBNAIL,
  }));
  await page.route('**/thumb/**', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: THUMBNAIL,
  }));
  await page.route('**/file/**', route => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: THUMBNAIL,
  }));
}

async function emitRaceEvent(page: Page, sequence: number, type: string): Promise<void> {
  await page.evaluate(payload => {
    const emit = (window as Window & {__emitVilraRaceEvent?: (value: unknown) => void})
      .__emitVilraRaceEvent;
    if (!emit) throw new Error('race EventSource fixture is not installed');
    emit(payload);
  }, {sequence, type, data: {}});
}

async function settleRenderer(page: Page, frameCount = 2): Promise<void> {
  await page.evaluate(async frames => {
    for (let frame = 0; frame < frames; frame += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  }, frameCount);
}

test('stale Gallery continuation cannot remount the active tab after tags finish', async ({page}) => {
  const staleTagsStarted = deferred();
  const releaseStaleTags = deferred();
  const imageA = raceImage('gallery-a', 'a');
  const imageB = raceImage('gallery-b', 'b');
  await installRaceFixture(page, {
    session: {
      root_path: '/race-fixture',
      root_paths: ['/race-fixture'],
      tabs: [galleryTab('tab-a', 'a'), galleryTab('tab-b', 'b')],
      active_tab_id: 'tab-a',
      search_tags: ['a'],
      search_mode: 'any',
      last_image_id: null,
      folder_tag_sync: true,
    },
    handleImages: (route, url) => {
      const image = url.searchParams.get('include_tags') === 'b' ? imageB : imageA;
      return route.fulfill({status: 200, json: {
        items: [image],
        page: {total: 1, next_cursor: null, has_more: false},
      }});
    },
    handleTags: async (route, requestNumber) => {
      if (requestNumber === 2) {
        staleTagsStarted.resolve();
        await releaseStaleTags.promise;
        return route.fulfill({
          status: 200,
          headers: {'x-vilra-race': 'stale-gallery-tags'},
          json: {tags: [tagMeta('stale')]},
        });
      }
      return route.fulfill({status: 200, json: {tags: [tagMeta('current')]}});
    },
  });

  await page.goto('/');
  await expect(page.locator('.card[data-id="gallery-a"]')).toBeVisible();
  await page.locator('#sort-select').selectOption('path_asc');
  await staleTagsStarted.promise;
  await page.locator('.tab[data-tab="tab-b"]').click();
  const activeCard = page.locator('.card[data-id="gallery-b"]');
  await expect(activeCard).toBeVisible();
  const activeCardHandle = await activeCard.elementHandle();
  expect(activeCardHandle).not.toBeNull();

  const staleResponse = page.waitForResponse(response => (
    response.headers()['x-vilra-race'] === 'stale-gallery-tags'
  ));
  releaseStaleTags.resolve();
  await staleResponse;
  await settleRenderer(page);

  await expect(page.locator('.tab[data-tab="tab-b"]')).toHaveClass(/active/);
  await expect(activeCard).toBeVisible();
  await expect(page.locator('.card[data-id="gallery-a"]')).toHaveCount(0);
  expect(await activeCardHandle!.evaluate(node => node.isConnected)).toBe(true);
});

test('stale Gallery error does not overwrite the current status', async ({page}) => {
  const staleImagesStarted = deferred();
  const releaseStaleImages = deferred();
  await installRaceFixture(page, {
    handleImages: async (route, url) => {
      const sort = url.searchParams.get('sort');
      if (sort === 'path_asc') {
        staleImagesStarted.resolve();
        await releaseStaleImages.promise;
        return route.fulfill({status: 503, json: {detail: 'stale gallery failure'}});
      }
      const image = raceImage(sort === 'size_desc' ? 'fresh-gallery' : 'initial-gallery', 'a');
      return route.fulfill({status: 200, json: {
        items: [image],
        page: {total: 1, next_cursor: null, has_more: false},
      }});
    },
  });

  await page.goto('/');
  await expect(page.locator('.card[data-id="initial-gallery"]')).toBeVisible();
  await page.locator('#sort-select').selectOption('path_asc');
  await staleImagesStarted.promise;
  await page.locator('#sort-select').selectOption('size_desc');
  await expect(page.locator('.card[data-id="fresh-gallery"]')).toBeVisible();

  const staleLogged = page.waitForEvent('console', message => (
    message.type() === 'error' && message.text().includes('stale gallery failure')
  ));
  releaseStaleImages.resolve();
  await staleLogged;
  await settleRenderer(page);

  await expect(page.locator('#status-text')).not.toContainText('stale gallery failure');
  await expect(page.locator('.card[data-id="fresh-gallery"]')).toBeVisible();
});

test('newer tag GET wins when responses finish in reverse order', async ({page}) => {
  const staleTagsStarted = deferred();
  const releaseStaleTags = deferred();
  await installRaceFixture(page, {
    handleImages: route => route.fulfill({status: 200, json: {
      items: [raceImage('tag-race-image', 'a')],
      page: {total: 1, next_cursor: null, has_more: false},
    }}),
    handleTags: async (route, requestNumber) => {
      if (requestNumber === 2) {
        staleTagsStarted.resolve();
        await releaseStaleTags.promise;
        return route.fulfill({
          status: 200,
          headers: {'x-vilra-race': 'stale-tag-get'},
          json: {tags: [tagMeta('stale-tag')]},
        });
      }
      const tag = requestNumber >= 3 ? 'new-tag' : 'base';
      return route.fulfill({status: 200, json: {tags: [tagMeta(tag)]}});
    },
  });

  await page.goto('/');
  await expect(page.locator('.card[data-id="tag-race-image"]')).toBeVisible();
  await emitRaceEvent(page, 1, 'tags_changed');
  await staleTagsStarted.promise;
  await emitRaceEvent(page, 2, 'tags_changed');
  await expect(page.locator('[data-sidebar-tag="new-tag"]')).toBeVisible();

  const staleResponse = page.waitForResponse(response => (
    response.headers()['x-vilra-race'] === 'stale-tag-get'
  ));
  releaseStaleTags.resolve();
  await staleResponse;
  await settleRenderer(page);

  await expect(page.locator('[data-sidebar-tag="new-tag"]')).toBeVisible();
  await expect(page.locator('[data-sidebar-tag="stale-tag"]')).toHaveCount(0);
});

test('tag mutation invalidates an older tag GET', async ({page}) => {
  const staleTagsStarted = deferred();
  const releaseStaleTags = deferred();
  await installRaceFixture(page, {
    handleImages: route => route.fulfill({status: 200, json: {
      items: [raceImage('tag-mutation-image', 'a')],
      page: {total: 1, next_cursor: null, has_more: false},
    }}),
    handleTags: async (route, requestNumber) => {
      if (requestNumber === 2) {
        staleTagsStarted.resolve();
        await releaseStaleTags.promise;
        return route.fulfill({
          status: 200,
          headers: {'x-vilra-race': 'pre-mutation-tag-get'},
          json: {tags: [tagMeta('stale-tag')]},
        });
      }
      return route.fulfill({status: 200, json: {tags: [tagMeta('base')]}});
    },
    handleTagMutation: route => route.fulfill({status: 200, json: {
      tag: tagMeta('fresh-tag'),
      tags: [tagMeta('base'), tagMeta('fresh-tag')],
    }}),
  });

  await page.goto('/');
  await expect(page.locator('.card[data-id="tag-mutation-image"]')).toBeVisible();
  await emitRaceEvent(page, 1, 'tags_changed');
  await staleTagsStarted.promise;
  await page.locator('#settings-toggle').click();
  await page.locator('[data-settings-tab="tags"]').click();
  await page.locator('#tag-admin-create').fill('fresh-tag');
  await page.locator('#tag-admin-create').press('Enter');
  await expect(page.locator('#tag-admin-list .tag-admin-row[data-tag="fresh-tag"]')).toBeVisible();

  const staleResponse = page.waitForResponse(response => (
    response.headers()['x-vilra-race'] === 'pre-mutation-tag-get'
  ));
  releaseStaleTags.resolve();
  await staleResponse;
  await settleRenderer(page);

  await expect(page.locator('#tag-admin-list .tag-admin-row[data-tag="fresh-tag"]')).toBeVisible();
  await expect(page.locator('#tag-admin-list .tag-admin-row[data-tag="stale-tag"]')).toHaveCount(0);
});

test('stale scroll restoration cannot move the newly selected tab', async ({page}) => {
  const staleCursorStarted = deferred();
  const releaseStaleCursor = deferred();
  await page.addInitScript(() => {
    type ScrollSpyWindow = Window & {__vilraScrollTargets?: number[]};
    const runtime = window as ScrollSpyWindow;
    const nativeScrollTo = window.scrollTo.bind(window);
    runtime.__vilraScrollTargets = [];
    window.scrollTo = ((optionsOrX?: ScrollToOptions | number, y?: number) => {
      const top = typeof optionsOrX === 'number' ? Number(y || 0) : Number(optionsOrX?.top || 0);
      runtime.__vilraScrollTargets?.push(top);
      if (typeof optionsOrX === 'number') nativeScrollTo(optionsOrX, y || 0);
      else nativeScrollTo(optionsOrX);
    }) as typeof window.scrollTo;
  });
  await installRaceFixture(page, {
    session: {
      root_path: '/race-fixture',
      root_paths: ['/race-fixture'],
      tabs: [galleryTab('tab-a', 'a', 4_000), galleryTab('tab-b', 'b', 600)],
      active_tab_id: 'tab-a',
      search_tags: ['a'],
      search_mode: 'any',
      last_image_id: null,
      folder_tag_sync: true,
    },
    handleImages: async (route, url) => {
      const tag = url.searchParams.get('include_tags');
      const cursor = url.searchParams.get('cursor');
      if (tag === 'a' && cursor) {
        staleCursorStarted.resolve();
        await releaseStaleCursor.promise;
        return route.fulfill({
          status: 200,
          headers: {'x-vilra-race': 'stale-cursor'},
          json: {
            items: Array.from({length: 48}, (_, index) => raceImage(`a-${index + 48}`, 'a', index + 48)),
            page: {total: null, next_cursor: null, has_more: false},
          },
        });
      }
      const items = Array.from({length: 48}, (_, index) => raceImage(`${tag}-${index}`, tag || 'a', index));
      return route.fulfill({status: 200, json: {
        items,
        page: tag === 'a'
          ? {total: 96, next_cursor: '48', has_more: true}
          : {total: 48, next_cursor: null, has_more: false},
      }});
    },
  });

  await page.goto('/');
  await staleCursorStarted.promise;
  await page.locator('.tab[data-tab="tab-b"]').click();
  await expect(page.locator('.card[data-id="b-0"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    (window as Window & {__vilraScrollTargets?: number[]}).__vilraScrollTargets?.includes(600)
  ))).toBe(true);
  await page.evaluate(() => {
    (window as Window & {__vilraScrollTargets?: number[]}).__vilraScrollTargets = [];
  });

  const staleResponse = page.waitForResponse(response => (
    response.headers()['x-vilra-race'] === 'stale-cursor'
  ));
  releaseStaleCursor.resolve();
  await staleResponse;
  await settleRenderer(page, 3);

  const staleScrollTargets = await page.evaluate(() => (
    (window as Window & {__vilraScrollTargets?: number[]}).__vilraScrollTargets || []
  ));
  expect(staleScrollTargets).not.toContain(4_000);
  await expect(page.locator('.tab[data-tab="tab-b"]')).toHaveClass(/active/);
  await expect(page.locator('.card[data-id="b-0"]')).toBeVisible();
});

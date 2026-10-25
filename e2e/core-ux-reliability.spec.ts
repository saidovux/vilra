import {expect, test, type Page, type Route} from '@playwright/test';

const THUMBNAIL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

type UxImage = {
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
  roots?: string[];
  images?: UxImage[];
  tags?: string[];
  handleImages?: (route: Route, url: URL) => Promise<void> | void;
  handleSession?: (route: Route, requestNumber: number) => Promise<void> | void;
  handleTagMutation?: (route: Route) => Promise<void> | void;
  handleTags?: (route: Route, requestNumber: number) => Promise<void> | void;
  onPickFolder?: () => void;
};

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolve = (): void => undefined;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

function image(id = 'ux-image', userTags: string[] = []): UxImage {
  return {
    id,
    path: `fixture/${id}.png`,
    thumb_url: `/thumb-file/${id}.jpg`,
    width: 64,
    height: 48,
    size: 1024,
    mtime: 100,
    tags: userTags.slice(),
    auto_tags: [],
    folder_tags: [],
    user_tags: userTags.slice(),
  };
}

function tagMeta(name: string) {
  return {
    name,
    normalized: name.toLowerCase(),
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

async function installFixture(page: Page, options: FixtureOptions = {}): Promise<void> {
  const roots = options.roots || [];
  const items = options.images || [];
  let tagRequestNumber = 0;
  let sessionRequestNumber = 0;

  await page.addInitScript(() => {
    class QuietEventSource {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      close(): void {}
    }
    Object.defineProperty(window, 'EventSource', {configurable: true, value: QuietEventSource});
  });
  await page.route('**/api/session', route => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({status: 200, json: {ok: true}});
    }
    sessionRequestNumber += 1;
    if (options.handleSession) return options.handleSession(route, sessionRequestNumber);
    return route.fulfill({status: 200, json: {
      root_path: roots.at(-1) || null,
      root_paths: roots,
      tabs: [],
      active_tab_id: null,
      search_tags: [],
      search_mode: 'any',
      last_image_id: null,
      folder_tag_sync: true,
    }});
  });
  await page.route('**/api/images?**', route => {
    if (options.handleImages) return options.handleImages(route, new URL(route.request().url()));
    return route.fulfill({status: 200, json: {
      items,
      page: {total: items.length, next_cursor: null, has_more: false},
    }});
  });
  await page.route('**/api/tag/**', route => {
    if (options.handleTagMutation) return options.handleTagMutation(route);
    const body = route.request().postDataJSON() as {tags?: string[]};
    const userTags = Array.isArray(body.tags) ? body.tags : [];
    return route.fulfill({status: 200, json: {
      tags: userTags,
      auto_tags: [],
      folder_tags: [],
      user_tags: userTags,
    }});
  });
  await page.route('**/api/tags', route => {
    tagRequestNumber += 1;
    if (options.handleTags) return options.handleTags(route, tagRequestNumber);
    return route.fulfill({status: 200, json: {tags: (options.tags || []).map(tagMeta)}});
  });
  await page.route('**/api/folders', route => route.fulfill({
    status: 200,
    json: {roots, items: []},
  }));
  await page.route('**/api/folder/pick', route => {
    options.onPickFolder?.();
    return route.fulfill({status: 200, json: {cancelled: true}});
  });
  await page.route('**/api/status', route => route.fulfill({status: 200, json: {
    db_ready: true,
    root: roots.at(-1) || null,
    root_paths: roots,
    running: false,
    queued: false,
  }}));
  await page.route('**/api/problems/summary', route => route.fulfill({status: 200, json: {
    total: 0,
    errors: 0,
    warnings: 0,
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

test('first run explains how to add a library and uses the existing picker', async ({page}) => {
  let pickRequests = 0;
  await installFixture(page, {onPickFolder: () => { pickRequests += 1; }});
  await page.setViewportSize({width: 1366, height: 768});
  await page.goto('/');

  await expect(page.locator('#empty-state')).toHaveAttribute('data-state', 'no_library');
  await expect(page.locator('#empty-state .label')).toHaveText('Библиотеки не добавлены');
  const action = page.locator('#empty-state-action');
  await expect(action).toHaveText('Добавить библиотеку');
  await expect(action).toBeVisible();
  await action.click();
  await expect.poll(() => pickRequests).toBe(1);
});

test('an empty connected library is distinct from filtered results', async ({page}) => {
  await installFixture(page, {roots: ['/empty-library']});
  await page.goto('/');

  await expect(page.locator('#empty-state')).toHaveAttribute('data-state', 'no_images');
  await expect(page.locator('#empty-state .label')).toHaveText('Изображения не найдены');
  await expect(page.locator('#empty-state')).toContainText('Проверьте содержимое папки');
  await expect(page.locator('#empty-state-action')).toBeHidden();
});

test('empty tag results offer reset and restore the gallery', async ({page}) => {
  const item = image('filter-image');
  await installFixture(page, {
    roots: ['/filter-library'],
    images: [item],
    tags: ['missing-tag'],
    handleImages: (route, url) => {
      const filtered = url.searchParams.get('include_tags') === 'missing-tag';
      const responseItems = filtered ? [] : [item];
      return route.fulfill({status: 200, json: {
        items: responseItems,
        page: {total: responseItems.length, next_cursor: null, has_more: false},
      }});
    },
  });
  await page.goto('/');
  await expect(page.locator('.card[data-id="filter-image"]')).toBeVisible();

  await page.locator('[data-sidebar-tag="missing-tag"]').click();
  await expect(page.locator('#empty-state')).toHaveAttribute('data-state', 'filtered_empty');
  await expect(page.locator('#empty-state .label')).toHaveText('Нет изображений по выбранным тегам');
  await expect(page.locator('#empty-state-action')).toHaveText('Сбросить фильтры');
  await page.locator('#empty-state-action').click();
  await expect(page.locator('.card[data-id="filter-image"]')).toBeVisible();
});

test('gallery load error is retryable and a successful retry restores content', async ({page}) => {
  const item = image('retry-image');
  let requests = 0;
  await installFixture(page, {
    roots: ['/retry-library'],
    handleImages: route => {
      requests += 1;
      if (requests === 1) {
        return route.fulfill({status: 503, json: {detail: 'SQLite temporarily unavailable'}});
      }
      return route.fulfill({status: 200, json: {
        items: [item],
        page: {total: 1, next_cursor: null, has_more: false},
      }});
    },
  });
  await page.goto('/');

  await expect(page.locator('#empty-state')).toHaveAttribute('data-state', 'load_error');
  await expect(page.locator('#empty-state .label')).toHaveText('Не удалось загрузить изображения');
  await expect(page.locator('#empty-state')).toContainText('SQLite temporarily unavailable');
  await page.locator('#empty-state-action').click();
  await expect(page.locator('.card[data-id="retry-image"]')).toBeVisible();
  await expect(page.locator('#empty-state')).toBeHidden();
  expect(requests).toBe(2);
});

test('session failure is not presented as a missing library and can be retried', async ({page}) => {
  let sessionRequests = 0;
  await installFixture(page, {
    handleSession: (route, requestNumber) => {
      sessionRequests = requestNumber;
      if (requestNumber === 1) {
        return route.fulfill({status: 500, json: {detail: 'session database unavailable'}});
      }
      return route.fulfill({status: 200, json: {
        root_path: null,
        root_paths: [],
        tabs: [],
        active_tab_id: null,
        search_tags: [],
        search_mode: 'any',
        last_image_id: null,
        folder_tag_sync: true,
      }});
    },
  });
  await page.goto('/');

  await expect(page.locator('#empty-state')).toHaveAttribute('data-state', 'load_error');
  await expect(page.locator('#empty-state')).toContainText('session database unavailable');
  await page.locator('#empty-state-action').click();
  await expect(page.locator('#empty-state')).toHaveAttribute('data-state', 'no_library');
  await expect(page.locator('#empty-state .label')).toHaveText('Библиотеки не добавлены');
  expect(sessionRequests).toBe(2);
});

test('single tag failures keep input and existing chips while successful saves update all surfaces', async ({page}) => {
  const item = image('tag-image');
  const publish = deferred();
  const catalogTags = new Set<string>();
  let mutationRequests = 0;
  await installFixture(page, {
    roots: ['/tag-library'],
    images: [item],
    handleTagMutation: async route => {
      mutationRequests += 1;
      const body = route.request().postDataJSON() as {tags?: string[]};
      const userTags = Array.isArray(body.tags) ? body.tags : [];
      if (mutationRequests === 1 || mutationRequests === 3) {
        await route.fulfill({status: 503, json: {detail: 'write rejected'}});
        return;
      }
      await publish.promise;
      userTags.forEach(tag => catalogTags.add(tag));
      await route.fulfill({status: 200, json: {
        tags: userTags,
        auto_tags: [],
        folder_tags: [],
        user_tags: userTags,
      }});
    },
    handleTags: route => route.fulfill({
      status: 200,
      json: {tags: [...catalogTags].map(tagMeta)},
    }),
  });
  await page.goto('/');
  await page.locator('.card[data-id="tag-image"]').click();
  const input = page.locator('#preview-tag-input');
  const notification = page.locator('#app-notification');

  await input.fill('kept-tag');
  await page.locator('#preview-tag-add').click();
  await expect(input).toHaveValue('kept-tag');
  await expect(notification).toContainText('Не удалось сохранить теги');
  await expect(page.locator('#preview-user-tags')).not.toContainText('kept-tag');

  await page.locator('#preview-tag-add').click();
  await expect(page.locator('#preview-tag-add')).toBeDisabled();
  await page.locator('#preview-tag-add').evaluate((button: HTMLButtonElement) => button.click());
  expect(mutationRequests).toBe(2);
  publish.resolve();
  await expect(input).toHaveValue('');
  await expect(page.locator('#preview-user-tags')).toContainText('kept-tag');
  await expect(notification).toContainText('Теги сохранены');
  await expect(page.locator('[data-sidebar-tag="kept-tag"]')).toBeVisible();

  await page.locator('#preview-user-tags button[data-tag="kept-tag"]').click();
  await expect(notification).toContainText('Не удалось сохранить теги');
  await expect(page.locator('#preview-user-tags')).toContainText('kept-tag');
  expect(mutationRequests).toBe(3);

  await page.locator('#preview-close').click();
  await expect(page.locator('.card[data-id="tag-image"] .card-tags')).toContainText('kept-tag');
});

test('a failed catalog refresh does not claim that the committed tag was lost', async ({page}) => {
  const item = image('catalog-image');
  let tagGets = 0;
  await installFixture(page, {
    roots: ['/catalog-library'],
    images: [item],
    handleTags: route => {
      tagGets += 1;
      if (tagGets > 1) return route.fulfill({status: 503, json: {detail: 'catalog unavailable'}});
      return route.fulfill({status: 200, json: {tags: []}});
    },
  });
  await page.goto('/');
  await page.locator('.card[data-id="catalog-image"]').click();
  await page.locator('#preview-tag-input').fill('persisted-tag');
  await page.locator('#preview-tag-add').click();

  await expect(page.locator('#preview-user-tags')).toContainText('persisted-tag');
  await expect(page.locator('#preview-tag-input')).toHaveValue('');
  const message = page.locator('#app-notification-message');
  await expect(message).toContainText('Теги сохранены, но список тегов не удалось обновить');
  await expect(message).not.toContainText('Не удалось сохранить теги');
});

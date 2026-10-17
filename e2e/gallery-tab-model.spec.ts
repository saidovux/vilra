import {expect, test} from '@playwright/test';

import {
  DEFAULT_SORT_MODE,
  isSortMode,
  makeDefaultTab,
  normalizeTabs,
  serializeGallerySession,
  SORT_MODES,
  updateTabTitle,
  type GalleryTab,
} from '../static/src/gallery/gallery-tab-model';

function normalizeTag(tag: unknown): string {
  return String(tag || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function tagName(tag: unknown): string {
  if (typeof tag === 'object' && tag !== null && !Array.isArray(tag)) {
    return String((tag as {name?: unknown}).name || '').trim().replace(/\s+/g, ' ');
  }
  return String(tag || '').trim().replace(/\s+/g, ' ');
}

function dedupeDisplayTags(tags: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  const source = Array.isArray(tags) ? tags : [];
  for (const tag of source) {
    const value = tagName(tag);
    const norm = normalizeTag(value);
    if (!value || seen.has(norm)) continue;
    seen.add(norm);
    result.push(value);
  }
  return result;
}

function tab(overrides: Partial<GalleryTab> = {}): GalleryTab {
  return {
    id: 'tab-a',
    title: 'Все фото',
    includeTags: [],
    excludeTags: [],
    matchMode: 'any',
    sortMode: DEFAULT_SORT_MODE,
    lastImageId: null,
    scrollTop: 0,
    ...overrides,
  };
}

test('default tabs keep the existing ID shape and every supported sort mode', () => {
  const value = makeDefaultTab();
  expect(value.id).toMatch(/^tab-[0-9a-z]+-[0-9a-z]{0,5}$/);
  expect({...value, id: '<dynamic>'}).toEqual({
    id: '<dynamic>',
    title: 'Все фото',
    includeTags: [],
    excludeTags: [],
    matchMode: 'any',
    sortMode: 'date_desc',
    lastImageId: null,
    scrollTop: 0,
  });
  expect(makeDefaultTab('Custom').title).toBe('Custom');
  expect(SORT_MODES).toEqual(['path_asc', 'path_desc', 'date_desc', 'date_asc', 'size_desc', 'size_asc']);
  for (const mode of SORT_MODES) expect(isSortMode(mode)).toBe(true);
  expect(isSortMode('invalid')).toBe(false);
  expect(isSortMode(undefined)).toBe(false);
});

test('modern tabs preserve camelCase priority, snake_case fallback, dedupe, and filtered numbering', () => {
  const normalized = normalizeTabs([
    null,
    {
      id: 'camel',
      title: 'Camel',
      includeTags: [' Red ', 'red', 'Blue'],
      include_tags: ['ignored'],
      excludeTags: [],
      exclude_tags: ['ignored'],
      matchMode: 'all',
      match_mode: 'any',
      sortMode: 'path_asc',
      sort_mode: 'size_desc',
      lastImageId: 'camel-image',
      last_image_id: 'ignored-image',
      scrollTop: 12,
      scroll_top: 44,
    },
    'invalid',
    {
      id: '',
      title: '',
      includeTags: [],
      include_tags: ['ignored-because-empty-array-is-truthy'],
      excludeTags: 0,
      exclude_tags: [' Hidden ', 'hidden'],
      matchMode: 'any',
      match_mode: 'all',
      sortMode: '',
      sort_mode: 'size_asc',
      lastImageId: '',
      last_image_id: 'snake-image',
      scrollTop: 0,
      scroll_top: 27,
    },
  ], {}, dedupeDisplayTags);

  expect(normalized).toEqual([
    tab({
      id: 'camel',
      title: 'Camel',
      includeTags: ['Red', 'Blue'],
      matchMode: 'all',
      sortMode: 'path_asc',
      lastImageId: 'camel-image',
      scrollTop: 12,
    }),
    tab({
      id: 'tab-1',
      includeTags: [],
      excludeTags: ['Hidden'],
      matchMode: 'all',
      sortMode: 'size_asc',
      lastImageId: 'snake-image',
      scrollTop: 27,
    }),
  ]);
});

test('invalid modern entries fall back to the unchanged legacy session model', () => {
  const normalized = normalizeTabs([null, 'invalid'], {
    search_tags: [' Red ', 'red', 'Blue'],
    search_mode: 'all',
    last_image_id: 42,
  }, dedupeDisplayTags);

  expect(normalized).toHaveLength(1);
  expect(normalized[0].id).toMatch(/^tab-[0-9a-z]+-[0-9a-z]{0,5}$/);
  expect({...normalized[0], id: '<dynamic>'}).toEqual({
    id: '<dynamic>',
    title: 'все Red + Blue',
    includeTags: ['Red', 'Blue'],
    excludeTags: [],
    matchMode: 'all',
    sortMode: 'date_desc',
    lastImageId: '42',
    scrollTop: 0,
  });
});

test('tab titles keep the existing any, all, exclude, empty, and length behavior', () => {
  const empty = tab({title: 'Old'});
  updateTabTitle(empty);
  expect(empty.title).toBe('Все фото');

  const any = tab({includeTags: ['red', 'blue'], excludeTags: ['hidden', 'draft']});
  updateTabTitle(any);
  expect(any.title).toBe('любой red / blue / без hidden, draft');

  const all = tab({includeTags: ['red', 'blue'], matchMode: 'all'});
  updateTabTitle(all);
  expect(all.title).toBe('все red + blue');

  const long = tab({includeTags: ['x'.repeat(100)]});
  updateTabTitle(long);
  expect(long.title).toHaveLength(80);
});

test('session serialization matches the existing PATCH payload without mutating inputs', () => {
  const defaultActive = tab();
  expect(serializeGallerySession([], null, defaultActive)).toEqual({
    tabs: [],
    active_tab_id: null,
    search_tags: [],
    last_image_id: null,
  });

  const first = tab({
    id: 'first',
    title: 'First',
    includeTags: ['red'],
    excludeTags: ['hidden'],
    matchMode: 'all',
    sortMode: 'path_desc',
    lastImageId: 'image-1',
    scrollTop: 123,
  });
  const second = tab({
    id: 'second',
    title: 'Second',
    includeTags: ['blue'],
    sortMode: 'size_desc',
    lastImageId: 'image-2',
    scrollTop: 456,
  });
  const tabs = [first, second];
  const before = JSON.stringify(tabs);

  const payload = serializeGallerySession(tabs, 'second', second);

  expect(payload).toEqual({
    tabs: [
      {
        id: 'first',
        title: 'First',
        includeTags: ['red'],
        excludeTags: ['hidden'],
        matchMode: 'all',
        sortMode: 'path_desc',
        lastImageId: 'image-1',
        scrollTop: 123,
      },
      {
        id: 'second',
        title: 'Second',
        includeTags: ['blue'],
        excludeTags: [],
        matchMode: 'any',
        sortMode: 'size_desc',
        lastImageId: 'image-2',
        scrollTop: 456,
      },
    ],
    active_tab_id: 'second',
    search_tags: ['blue'],
    last_image_id: 'image-2',
  });
  expect(payload.tabs[0].includeTags).toBe(first.includeTags);
  expect(payload.search_tags).toBe(second.includeTags);
  expect(JSON.stringify(tabs)).toBe(before);

  const falsy = {
    ...tab({id: 'falsy'}),
    includeTags: undefined,
    excludeTags: undefined,
    matchMode: '',
    sortMode: '',
    lastImageId: '',
    scrollTop: Number.NaN,
  } as unknown as GalleryTab;
  expect(serializeGallerySession([falsy], null, falsy)).toEqual({
    tabs: [{
      id: 'falsy',
      title: 'Все фото',
      includeTags: [],
      excludeTags: [],
      matchMode: 'any',
      sortMode: 'date_desc',
      lastImageId: null,
      scrollTop: 0,
    }],
    active_tab_id: null,
    search_tags: [],
    last_image_id: null,
  });
});

import {expect, test} from '@playwright/test';

import {DEFAULT_SORT_MODE, type GalleryTab} from '../static/src/gallery/gallery-tab-model';
import {GalleryTabsState} from '../static/src/gallery/gallery-tabs-state';

function tab(id: string, overrides: Partial<GalleryTab> = {}): GalleryTab {
  return {
    id,
    title: `Tab ${id}`,
    includeTags: [],
    excludeTags: [],
    matchMode: 'any',
    sortMode: DEFAULT_SORT_MODE,
    lastImageId: null,
    scrollTop: 0,
    ...overrides,
  };
}

test('starts empty and creates the active tab lazily', () => {
  const state = new GalleryTabsState();

  expect(state.list).toEqual([]);
  expect(state.activeId).toBeNull();

  const current = state.current();
  expect(state.list).toHaveLength(1);
  expect(state.list[0]).toBe(current);
  expect(state.activeId).toBe(current.id);
  expect(state.current()).toBe(current);
});

test('current normalizes only the returned original tab object', () => {
  const malformed = {
    ...tab('malformed'),
    includeTags: null,
    excludeTags: 'not-an-array',
    matchMode: 'invalid',
    sortMode: 'invalid',
  } as unknown as GalleryTab;
  const untouched = {
    ...tab('untouched'),
    includeTags: null,
    excludeTags: null,
    matchMode: 'invalid',
    sortMode: 'invalid',
  } as unknown as GalleryTab;
  const state = new GalleryTabsState();
  state.restore([malformed, untouched], malformed.id);

  const current = state.current();

  expect(current).toBe(malformed);
  expect(malformed.includeTags).toEqual([]);
  expect(malformed.excludeTags).toEqual([]);
  expect(malformed.matchMode).toBe('any');
  expect(malformed.sortMode).toBe(DEFAULT_SORT_MODE);
  expect(untouched.includeTags).toBeNull();
  expect(untouched.excludeTags).toBeNull();
});

test('add mutates the current list, selects the new tab, and returns that object', () => {
  const state = new GalleryTabsState();
  const first = state.current();
  const originalList = state.list;

  const added = state.add();

  expect(state.list).toBe(originalList);
  expect(state.list).toEqual([first, added]);
  expect(state.activeId).toBe(added.id);
  expect(state.current()).toBe(added);
});

test('select stores an unknown ID until current applies the original fallback', () => {
  const first = tab('first');
  const second = tab('second');
  const state = new GalleryTabsState();
  state.restore([first, second], second.id);

  state.select('missing');
  expect(state.activeId).toBe('missing');

  expect(state.current()).toBe(first);
  expect(state.activeId).toBe(first.id);
});

test('closing the only tab replaces it even when the requested ID is unknown', () => {
  for (const closingId of ['only', 'missing']) {
    const only = tab('only');
    const state = new GalleryTabsState();
    state.restore([only], only.id);

    state.close(closingId);

    expect(state.list).toHaveLength(1);
    expect(state.list[0]).not.toBe(only);
    expect(state.activeId).toBe(state.list[0].id);
  }
});

test('closing a non-active tab preserves the active tab object and ID', () => {
  const first = tab('first');
  const second = tab('second');
  const third = tab('third');
  const state = new GalleryTabsState();
  state.restore([first, second, third], third.id);

  state.close(second.id);

  expect(state.list).toEqual([first, third]);
  expect(state.activeId).toBe(third.id);
  expect(state.current()).toBe(third);
});

test('closing the active tab selects the previous tab', () => {
  const first = tab('first');
  const second = tab('second');
  const third = tab('third');
  const state = new GalleryTabsState();
  state.restore([first, second, third], second.id);

  state.close(second.id);

  expect(state.list).toEqual([first, third]);
  expect(state.activeId).toBe(first.id);
  expect(state.current()).toBe(first);
});

test('closing an unknown ID with multiple tabs preserves composition and active ID', () => {
  const first = tab('first');
  const second = tab('second');
  const restored = [first, second];
  const state = new GalleryTabsState();
  state.restore(restored, second.id);

  state.close('missing');

  expect(state.list).toEqual([first, second]);
  expect(state.list[0]).toBe(first);
  expect(state.list[1]).toBe(second);
  expect(state.activeId).toBe(second.id);
});

test('restore keeps order, object identity, and a valid active ID', () => {
  const first = tab('first');
  const second = tab('second');
  const restored = [first, second];
  const state = new GalleryTabsState();

  state.restore(restored, second.id);

  expect(state.list).toBe(restored);
  expect(state.list).toEqual([first, second]);
  expect(state.current()).toBe(second);
});

test('restore falls back to the first tab for empty or unknown active IDs', () => {
  for (const activeId of [null, '', 'missing']) {
    const first = tab('first');
    const second = tab('second');
    const state = new GalleryTabsState();

    state.restore([first, second], activeId);

    expect(state.activeId).toBe(first.id);
    expect(state.current()).toBe(first);
  }
});

test('restore preserves duplicate IDs and their original objects', () => {
  const first = tab('duplicate', {title: 'First'});
  const second = tab('duplicate', {title: 'Second'});
  const third = tab('third');
  const restored = [first, second, third];
  const state = new GalleryTabsState();

  state.restore(restored, 'duplicate');

  expect(state.list).toBe(restored);
  expect(state.list).toEqual([first, second, third]);
  expect(state.current()).toBe(first);
});

test('state operations do not require DOM or perform fetches', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('unexpected fetch');
  }) as typeof fetch;

  try {
    expect('document' in globalThis).toBe(false);
    const first = tab('first');
    const state = new GalleryTabsState();
    state.restore([first], first.id);
    state.current();
    state.add();
    state.select(first.id);
    state.close(first.id);
    state.reset();
    expect(fetchCalled).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

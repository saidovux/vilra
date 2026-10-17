import {expect, test} from '@playwright/test';

import {
  imageArray,
  imagePage,
  imagesFromRecord,
  mergeRefreshedPageIntoLoadedImages,
  normalizeImageItem,
  pageTotalValue,
  type ImageItem,
} from '../static/src/gallery/image-data';
import {buildImageQueryParams} from '../static/src/gallery/image-query';

function image(id: string, path = `${id}.jpg`): ImageItem {
  return {
    id,
    path,
    thumb_url: undefined,
    tags: [],
    auto_tags: [],
    folder_tags: [],
    user_tags: [],
    width: undefined,
    height: undefined,
    aspect_ratio: undefined,
    size: undefined,
    mtime: undefined,
  };
}

test('image data normalizes valid values and preserves existing defaults', () => {
  expect(normalizeImageItem({
    id: 17,
    path: 'folder/image.jpg',
    thumb_url: '/thumb-file/17.jpg',
    tags: ['one', 2, ''],
    auto_tags: ['auto'],
    folder_tags: ['folder'],
    user_tags: ['user'],
    width: '640',
    height: 480,
    aspect_ratio: '1.3333',
    size: '1024',
    mtime: 12.5,
  })).toEqual({
    id: '17',
    path: 'folder/image.jpg',
    thumb_url: '/thumb-file/17.jpg',
    tags: ['one', '2'],
    auto_tags: ['auto'],
    folder_tags: ['folder'],
    user_tags: ['user'],
    width: 640,
    height: 480,
    aspect_ratio: 1.3333,
    size: 1024,
    mtime: 12.5,
  });
});

test('image data rejects missing identity and safely normalizes invalid fields', () => {
  expect(normalizeImageItem(null)).toBeNull();
  expect(normalizeImageItem({path: 'missing-id.jpg'})).toBeNull();
  expect(normalizeImageItem({id: 'missing-path'})).toBeNull();
  expect(normalizeImageItem({
    id: 'valid',
    path: 'valid.jpg',
    thumb_url: 42,
    tags: 'not-an-array',
    width: 'invalid',
  })).toEqual({
    id: 'valid',
    path: 'valid.jpg',
    thumb_url: undefined,
    tags: [],
    auto_tags: [],
    folder_tags: [],
    user_tags: [],
    width: undefined,
    height: undefined,
    aspect_ratio: undefined,
    size: undefined,
    mtime: undefined,
  });
  expect(imageArray([null, {id: 'a', path: 'a.jpg'}, {id: '', path: 'bad.jpg'}]))
    .toEqual([image('a')]);
});

test('image records support items and legacy images response shapes', () => {
  expect(imagesFromRecord({items: [{id: 'item', path: 'item.jpg'}]})).toEqual([image('item')]);
  expect(imagesFromRecord({images: [{id: 'legacy', path: 'legacy.jpg'}]})).toEqual([image('legacy')]);
  expect(imagesFromRecord({items: [], images: [{id: 'ignored', path: 'ignored.jpg'}]})).toEqual([]);
  expect(imagePage({total: '4', next_cursor: 'cursor-4', has_more: 1})).toEqual({
    total: '4',
    next_cursor: 'cursor-4',
    has_more: true,
  });
  expect(imagePage(null)).toBeNull();
  expect(pageTotalValue({total: '4'})).toBe(4);
  expect(pageTotalValue({total: ''})).toBeNull();
});

test('refreshed page merge replaces matching IDs without losing loaded order', () => {
  const existing = [image('a'), image('b', 'old-b.jpg'), image('c')];
  const refreshed = [image('x'), image('b', 'new-b.jpg')];

  expect(mergeRefreshedPageIntoLoadedImages(existing, refreshed)).toEqual([
    image('x'),
    image('b', 'new-b.jpg'),
    image('a'),
    image('c'),
  ]);
  expect(existing.map(item => item.id)).toEqual(['a', 'b', 'c']);
});

test('image query preserves filters and first-page versus cursor semantics', () => {
  const firstPage = buildImageQueryParams({
    includeTags: ['red', 'blue'],
    excludeTags: [],
    matchMode: 'any',
    limit: 48,
    sortMode: 'date_desc',
    includeTotal: true,
  });
  expect(Object.fromEntries(firstPage)).toEqual({
    include_tags: 'red,blue',
    match_mode: 'any',
    limit: '48',
    sort: 'date_desc',
    include_total: '1',
  });

  const cursorPage = buildImageQueryParams({
    includeTags: ['red'],
    excludeTags: ['hidden', 'draft'],
    matchMode: 'all',
    limit: 48,
    sortMode: 'path_asc',
    includeTotal: false,
    cursor: 'next-page',
  });
  expect(Object.fromEntries(cursorPage)).toEqual({
    include_tags: 'red',
    exclude_tags: 'hidden,draft',
    match_mode: 'all',
    limit: '48',
    sort: 'path_asc',
    include_total: '0',
    cursor: 'next-page',
  });
});

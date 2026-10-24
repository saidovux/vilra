import {expect, test} from '@playwright/test';
import {
  dedupeDisplayTags,
  normalizeTag,
  splitTagPrefix,
  TagCatalog,
  tagName,
} from '../static/src/tags/tag-catalog';

test('empty and invalid catalog values produce no entries without DOM or fetch', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('TagCatalog must not fetch');
  }) as typeof fetch;
  try {
    const catalog = new TagCatalog();
    catalog.replace(undefined);
    expect(catalog.names).toEqual([]);
    catalog.replace([null, false, 0, '', '   ', {}, {name: null}]);
    expect(catalog.names).toEqual([]);
    expect(catalog.getMeta(' New   Tag ')).toEqual({
      name: 'New Tag',
      normalized: 'new tag',
      color: null,
      image_count: 0,
      auto_count: 0,
      user_count: 0,
      user_defined: false,
      is_auto: false,
      source: 'user',
      sources: [],
    });
    expect(fetchCalls).toBe(0);
    expect('document' in globalThis).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('mixed catalog values preserve first appearance order and case-insensitive identity', () => {
  const catalog = new TagCatalog();
  catalog.replace([
    ' First   Tag ',
    {name: 'Second Tag', image_count: 2},
    'first tag',
    {name: 'THIRD'},
    {name: ' second   tag ', image_count: 99},
    {label: 'invalid'},
  ]);

  expect(catalog.names).toEqual(['First Tag', 'Second Tag', 'THIRD']);
  expect(catalog.getMeta('SECOND TAG').image_count).toBe(2);
  expect(catalog.findDisplayTag('  first TAG ')).toBe('First Tag');
  expect(catalog.findDisplayTag(' Unknown   Tag ')).toBe('Unknown Tag');
});

test('object metadata keeps every field and preserves existing source rules', () => {
  const catalog = new TagCatalog();
  catalog.replace([
    {
      name: 'Mixed',
      normalized: 'server-normalized',
      color: '#123456',
      image_count: 7,
      auto_count: 2,
      user_count: 3,
      user_defined: false,
      is_auto: false,
      source: 'user',
      sources: ['user', 'invalid', 'auto'],
    },
    {
      name: 'Derived',
      auto_count: 4,
      user_count: 1,
    },
    {
      name: 'Source Only',
      source: 'auto',
    },
  ]);

  expect(catalog.getMeta('mixed')).toEqual({
    name: 'Mixed',
    normalized: 'server-normalized',
    color: '#123456',
    image_count: 7,
    auto_count: 2,
    user_count: 3,
    user_defined: true,
    is_auto: true,
    source: 'auto',
    sources: ['user', 'auto'],
  });
  expect(catalog.getMeta('derived')).toMatchObject({
    user_defined: true,
    is_auto: true,
    source: 'auto',
    sources: ['auto', 'user'],
  });
  expect(catalog.getMeta('source only')).toMatchObject({
    user_defined: false,
    is_auto: false,
    source: 'auto',
    sources: [],
  });
});

test('string reload retains prior metadata while object reload replaces server values', () => {
  const catalog = new TagCatalog();
  catalog.replace([{
    name: 'Keep Me',
    normalized: 'keep me',
    color: '#ABCDEF',
    image_count: 12,
    auto_count: 5,
    user_count: 2,
    user_defined: true,
    is_auto: true,
    source: 'auto',
    sources: ['auto', 'user'],
  }]);

  catalog.replace([' keep   ME ']);
  expect(catalog.getMeta('KEEP ME')).toEqual({
    name: 'keep ME',
    normalized: 'keep me',
    color: '#ABCDEF',
    image_count: 12,
    auto_count: 5,
    user_count: 2,
    user_defined: true,
    is_auto: true,
    source: 'auto',
    sources: ['auto', 'user'],
  });

  catalog.replace([{
    name: 'Keep Me',
    normalized: 'replacement',
    color: '#010203',
    image_count: 1,
    auto_count: 0,
    user_count: 0,
    user_defined: false,
    is_auto: false,
    source: 'user',
    sources: ['user'],
  }]);
  expect(catalog.getMeta('keep me')).toEqual({
    name: 'Keep Me',
    normalized: 'replacement',
    color: '#010203',
    image_count: 1,
    auto_count: 0,
    user_count: 0,
    user_defined: false,
    is_auto: false,
    source: 'user',
    sources: ['user'],
  });
});

test('tag input helpers retain whitespace, prefix, normalization, and dedupe semantics', () => {
  expect(normalizeTag('  MiXeD   Tag  ')).toBe('mixed tag');
  expect(tagName({name: '  Display   Name '})).toBe('Display Name');
  expect(splitTagPrefix('  !  Excluded   Tag ')).toEqual({prefix: '!', value: 'Excluded Tag'});
  expect(splitTagPrefix(' -Other ')).toEqual({prefix: '-', value: 'Other'});
  expect(splitTagPrefix(' Included   Tag ')).toEqual({prefix: '', value: 'Included Tag'});
  expect(dedupeDisplayTags([
    ' First ',
    {name: 'first'},
    'Second   Tag',
    ' second tag ',
    '',
    null,
  ])).toEqual(['First', 'Second Tag']);
});

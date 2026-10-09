const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {resolveSqlitePath, resolveTauriAppData} = require('./runtime-paths.cjs');

test('resolves the Tauri-compatible Linux application data path', () => {
  const options = {platform: 'linux', env: {}, home: '/home/example'};
  assert.equal(resolveTauriAppData(options), '/home/example/.local/share/app.tagimage.desktop');
  assert.equal(
    resolveSqlitePath(options),
    '/home/example/.local/share/app.tagimage.desktop/tagimage.sqlite',
  );
});

test('respects XDG data and explicit absolute or relative overrides', () => {
  assert.equal(
    resolveSqlitePath({
      platform: 'linux',
      home: '/home/example',
      env: {XDG_DATA_HOME: '/data', TAGIMAGE_SQLITE_PATH: 'custom.sqlite'},
    }),
    '/data/app.tagimage.desktop/custom.sqlite',
  );
  assert.equal(
    resolveSqlitePath({
      platform: 'linux',
      home: '/home/example',
      env: {TAGIMAGE_SQLITE_PATH: path.resolve('/tmp/vilra.sqlite')},
    }),
    path.resolve('/tmp/vilra.sqlite'),
  );
});

test('resolves macOS and Windows application data conventions', () => {
  assert.equal(
    resolveSqlitePath({platform: 'darwin', env: {}, home: '/Users/example'}),
    '/Users/example/Library/Application Support/app.tagimage.desktop/tagimage.sqlite',
  );
  assert.equal(
    resolveSqlitePath({platform: 'win32', env: {APPDATA: 'C:\\Users\\Example\\AppData\\Roaming'}, home: 'C:\\Users\\Example'}),
    path.join('C:\\Users\\Example\\AppData\\Roaming', 'app.tagimage.desktop', 'tagimage.sqlite'),
  );
});

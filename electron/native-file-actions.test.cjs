const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {createNativeFileActions} = require('./native-file-actions.cjs');

function jsonResponse(ok, payload) {
  return {ok, json: async () => payload};
}

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vilra-file-actions-'));
  const root = path.join(directory, 'library');
  const file = path.join(root, 'nested', 'photo one.jpg');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, 'image');
  const calls = [];
  const shell = {
    openPath: async target => {
      calls.push({method: 'openPath', target});
      return options.openPathError || '';
    },
    showItemInFolder: target => calls.push({method: 'showItemInFolder', target}),
  };
  const fetchCalls = [];
  const fetchImpl = async url => {
    fetchCalls.push(String(url));
    return options.response || jsonResponse(true, {
      image_id: 'image-1',
      root_path: root,
      absolute_path: file,
    });
  };
  let trustedChecks = 0;
  const actions = createNativeFileActions({
    fs,
    path,
    shell,
    fetchImpl,
    getLocalOrigin: () => 'http://127.0.0.1:8123',
    requireTrustedMainFrame: () => {
      trustedChecks += 1;
      if (options.untrusted) throw new Error('untrusted frame');
    },
  });
  return {
    actions,
    calls,
    fetchCalls,
    file,
    root,
    trustedChecks: () => trustedChecks,
    cleanup: () => fs.rmSync(directory, {recursive: true, force: true}),
  };
}

test('native original and reveal actions resolve IDs through Rust before using Electron shell', async t => {
  const value = fixture();
  t.after(value.cleanup);

  await value.actions.openOriginal({}, 'image-1');
  await value.actions.revealImage({}, 'image-1');

  assert.deepEqual(value.calls, [
    {method: 'openPath', target: fs.realpathSync(value.file)},
    {method: 'showItemInFolder', target: fs.realpathSync(value.file)},
  ]);
  assert.deepEqual(value.fetchCalls, [
    'http://127.0.0.1:8123/api/images/image-1/local-file',
    'http://127.0.0.1:8123/api/images/image-1/local-file',
  ]);
  assert.equal(value.trustedChecks(), 2);
});

test('native file actions reject arbitrary paths and untrusted frames', async t => {
  const value = fixture();
  t.after(value.cleanup);
  await assert.rejects(value.actions.openOriginal({}, '/tmp/private.jpg'), /Invalid image ID/);
  assert.equal(value.fetchCalls.length, 0);

  const untrusted = fixture({untrusted: true});
  t.after(untrusted.cleanup);
  await assert.rejects(untrusted.actions.revealImage({}, 'image-1'), /untrusted frame/);
  assert.equal(untrusted.fetchCalls.length, 0);
  assert.equal(untrusted.calls.length, 0);
});

test('native file actions reject missing, outside, and malformed API results', async t => {
  const missing = fixture();
  t.after(missing.cleanup);
  fs.rmSync(missing.file);
  await assert.rejects(missing.actions.openOriginal({}, 'image-1'), /ENOENT/);
  assert.equal(missing.calls.length, 0);

  const outside = fixture();
  t.after(outside.cleanup);
  const outsideFile = path.join(path.dirname(outside.root), 'outside.jpg');
  fs.writeFileSync(outsideFile, 'image');
  outside.actions = createNativeFileActions({
    fs,
    path,
    shell: {
      openPath: async target => {
        outside.calls.push({method: 'openPath', target});
        return '';
      },
      showItemInFolder: target => outside.calls.push({method: 'showItemInFolder', target}),
    },
    fetchImpl: async () => jsonResponse(true, {
      image_id: 'image-1',
      root_path: outside.root,
      absolute_path: outsideFile,
    }),
    getLocalOrigin: () => 'http://127.0.0.1:8123',
    requireTrustedMainFrame: () => undefined,
  });
  await assert.rejects(outside.actions.revealImage({}, 'image-1'), /outside the active library/);
  assert.equal(outside.calls.length, 0);

  const malformed = fixture({
    response: jsonResponse(true, {image_id: 'different', root_path: '/', absolute_path: '/tmp/a'}),
  });
  t.after(malformed.cleanup);
  await assert.rejects(malformed.actions.openOriginal({}, 'image-1'), /invalid file information/);
});

test('native original action reports Rust API and Electron shell failures', async t => {
  const apiFailure = fixture({
    response: jsonResponse(false, {detail: 'Original file is unavailable'}),
  });
  t.after(apiFailure.cleanup);
  await assert.rejects(
    apiFailure.actions.openOriginal({}, 'image-1'),
    /Original file is unavailable/,
  );
  assert.equal(apiFailure.calls.length, 0);

  const shellFailure = fixture({openPathError: 'No application is associated with this file'});
  t.after(shellFailure.cleanup);
  await assert.rejects(
    shellFailure.actions.openOriginal({}, 'image-1'),
    /No application is associated/,
  );
});

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  REQUIRED_STATIC_FILES,
  SIDECAR_NAMES,
  assertPackagedResources,
  resolveRuntimeBuildId,
  resolveRuntimeLayout,
} = require('./runtime-layout.cjs');

test('development layout uses repository static files and Cargo target sidecars', () => {
  const layout = resolveRuntimeLayout({
    isPackaged: false,
    resourcesPath: '/unused',
    repoRoot: '/workspace/vilra',
    targetRoot: '/workspace/vilra/target',
    targetTriple: 'x86_64-unknown-linux-gnu',
    platform: 'linux',
    env: {},
  });
  assert.equal(layout.workingDirectory, '/workspace/vilra');
  assert.equal(layout.staticDirectory, path.join('/workspace/vilra', 'static'));
  assert.equal(
    layout.sidecarPath('imgviewer-api-server'),
    path.join(
      '/workspace/vilra/target',
      'x86_64-unknown-linux-gnu',
      'release',
      'imgviewer-api-server',
    ),
  );
  assert.equal(layout.buildInfoPath, null);
});

test('packaged layout uses external resources and resolves relative static override there', () => {
  const resourcesPath = '/opt/Vilra/resources';
  const layout = resolveRuntimeLayout({
    isPackaged: true,
    resourcesPath,
    repoRoot: '/must/not/be/used',
    targetRoot: null,
    targetTriple: null,
    platform: 'linux',
    env: {},
  });
  assert.equal(layout.workingDirectory, resourcesPath);
  assert.equal(layout.staticDirectory, path.join(resourcesPath, 'static'));
  assert.equal(
    layout.sidecarPath('imgviewer-thumb-worker'),
    path.join(resourcesPath, 'bin', 'imgviewer-thumb-worker'),
  );
  assert.equal(layout.buildInfoPath, path.join(resourcesPath, 'build-info.json'));

  const windowsLayout = resolveRuntimeLayout({
    isPackaged: true,
    resourcesPath,
    platform: 'win32',
    env: {},
  });
  assert.equal(
    windowsLayout.sidecarPath('imgviewer-metadata-worker'),
    path.join(resourcesPath, 'bin', 'imgviewer-metadata-worker.exe'),
  );

  const overridden = resolveRuntimeLayout({
    isPackaged: true,
    resourcesPath,
    platform: 'linux',
    env: {TAGIMAGE_STATIC_DIR: 'alternate-static'},
  });
  assert.equal(overridden.staticDirectory, path.join(resourcesPath, 'alternate-static'));
});

test('packaged build ID is loaded without invoking the development Git resolver', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vilra-build-info-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({
    gitHead: 'a'.repeat(40),
    buildId: 'aaaaaaaaaaaa',
    version: '0.2.1',
  }));
  const layout = resolveRuntimeLayout({
    isPackaged: true,
    resourcesPath: root,
    platform: 'linux',
    env: {},
  });
  assert.equal(resolveRuntimeBuildId(layout, () => {
    throw new Error('Git must not be called');
  }), 'aaaaaaaaaaaa');
});

test('packaged resource validation requires all sidecars, frontend files, and build info', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vilra-package-resources-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const name of SIDECAR_NAMES) {
    const file = path.join(root, 'bin', name);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, name);
    fs.chmodSync(file, 0o755);
  }
  for (const relative of REQUIRED_STATIC_FILES) {
    const file = path.join(root, 'static', relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, relative);
  }
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({
    gitHead: 'b'.repeat(40),
    buildId: 'bbbbbbbbbbbb',
    version: '0.2.1',
  }));

  assert.doesNotThrow(() => assertPackagedResources(root, 'linux'));
  fs.rmSync(path.join(root, 'static', 'dist', 'app.js'));
  assert.throws(
    () => assertPackagedResources(root, 'linux'),
    /Required Electron package resource is missing/,
  );
});

test('Windows packaged resource validation requires exe sidecars', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vilra-win-package-resources-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const name of SIDECAR_NAMES) {
    const file = path.join(root, 'bin', `${name}.exe`);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, name);
  }
  for (const relative of REQUIRED_STATIC_FILES) {
    const file = path.join(root, 'static', relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, relative);
  }
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({
    gitHead: 'c'.repeat(40),
    buildId: 'cccccccccccc',
    version: '0.2.1',
  }));

  assert.doesNotThrow(() => assertPackagedResources(root, 'win32'));
  fs.rmSync(path.join(root, 'bin', `${SIDECAR_NAMES[0]}.exe`));
  assert.throws(
    () => assertPackagedResources(root, 'win32'),
    /Required Electron package resource is missing/,
  );
});

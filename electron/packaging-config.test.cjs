const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {getConfig, validateConfiguration} = require('app-builder-lib/out/util/config/config');
const {DebugLogger} = require('builder-util/out/DebugLogger');

const repoRoot = path.resolve(__dirname, '..');

test('electron-builder configuration is valid, explicit, and AppImage-only', async () => {
  const parsed = await getConfig(repoRoot, 'electron-builder.yml', null);
  await validateConfiguration(parsed, new DebugLogger(false));
  assert.equal(parsed.appId, 'app.tagimage.desktop.electron');
  assert.equal(parsed.directories.output, 'dist-electron');
  assert.equal(parsed.asar, true);
  assert.equal(parsed.linux.artifactName, 'Vilra-Electron_${version}_amd64.${ext}');

  const config = fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8');
  for (const expected of [
    'appId: app.tagimage.desktop.electron',
    'output: dist-electron',
    'electron/main.cjs',
    'electron/preload.cjs',
    'electron/runtime-layout.cjs',
    'electron/runtime-paths.cjs',
    'from: electron/package-resources/bin',
    'from: electron/package-resources/static',
    'from: electron/package-resources/build-info.json',
    'target: AppImage',
    'Vilra-Electron_${version}_amd64.${ext}',
  ]) {
    assert.ok(config.includes(expected), `missing builder configuration: ${expected}`);
  }
  for (const forbidden of ['src-tauri/binaries', 'target: deb', 'target: rpm', 'asar: false']) {
    assert.equal(config.includes(forbidden), false, `unexpected builder configuration: ${forbidden}`);
  }
});

test('package scripts keep dev runtime and make Electron build self-contained', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.main, 'electron/main.cjs');
  assert.ok(packageJson.scripts['electron:dev'].includes('electron:prepare'));
  assert.ok(packageJson.scripts['electron:build'].includes('electron:prepare'));
  assert.ok(packageJson.scripts['electron:build'].includes('electron:package:prepare'));
  assert.ok(packageJson.scripts['electron:build'].includes('--linux AppImage --x64'));
});

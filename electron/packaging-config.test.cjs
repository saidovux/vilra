const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {getConfig, validateConfiguration} = require('app-builder-lib/out/util/config/config');
const {DebugLogger} = require('builder-util/out/DebugLogger');

const repoRoot = path.resolve(__dirname, '..');

test('electron-builder configuration is valid for Linux AppImage and Windows NSIS', async () => {
  const parsed = await getConfig(repoRoot, 'electron-builder.yml', null);
  await validateConfiguration(parsed, new DebugLogger(false));
  assert.equal(parsed.appId, 'app.tagimage.desktop');
  assert.equal(parsed.directories.output, 'dist-electron');
  assert.equal(parsed.asar, true);
  assert.equal(parsed.linux.artifactName, 'Vilra_${version}_amd64.${ext}');
  assert.equal(parsed.linux.syncDesktopName, true);
  assert.equal(parsed.win.artifactName, 'Vilra_Setup_${version}_x64.${ext}');
  assert.equal(parsed.nsis.oneClick, false);
  assert.equal(parsed.nsis.perMachine, false);

  const config = fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8');
  for (const expected of [
    'appId: app.tagimage.desktop',
    'output: dist-electron',
    'electron/main.cjs',
    'electron/preload.cjs',
    'electron/diagnostics.cjs',
    'electron/native-file-actions.cjs',
    'electron/runtime-layout.cjs',
    'electron/runtime-paths.cjs',
    'from: electron/package-resources/bin',
    'from: electron/package-resources/static',
    'from: electron/package-resources/build-info.json',
    'target: AppImage',
    'Vilra_${version}_amd64.${ext}',
    'icon: app-icon.png',
    'syncDesktopName: true',
    'target: nsis',
    'Vilra_Setup_${version}_x64.${ext}',
    'oneClick: false',
  ]) {
    assert.ok(config.includes(expected), `missing builder configuration: ${expected}`);
  }
  for (const forbidden of ['target: deb', 'target: rpm', 'asar: false']) {
    assert.equal(config.includes(forbidden), false, `unexpected builder configuration: ${forbidden}`);
  }
  const oldAppId = ['app.tagimage.desktop', 'electron'].join('.');
  const oldArtifactPrefix = `${['Vilra', 'Electron'].join('-')}_`;
  assert.equal(config.includes(oldAppId), false);
  assert.equal(config.includes(oldArtifactPrefix), false);
});

test('package scripts keep dev runtime and make Electron build self-contained', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  assert.equal(packageJson.version, '0.2.1');
  assert.equal(packageLock.version, '0.2.1');
  assert.equal(packageLock.packages[''].version, '0.2.1');
  assert.equal(packageJson.desktopName, 'Vilra');
  assert.equal(packageJson.main, 'electron/main.cjs');
  assert.ok(packageJson.scripts['electron:dev'].includes('electron:prepare'));
  assert.equal(packageJson.scripts['electron:build'], 'npm run build:linux');
  assert.ok(packageJson.scripts['build:linux'].includes('electron:prepare'));
  assert.ok(packageJson.scripts['build:linux'].includes('electron:package:prepare'));
  assert.ok(packageJson.scripts['build:linux'].includes('--linux AppImage --x64'));
  assert.ok(packageJson.scripts['build:linux'].includes('--publish never'));
  assert.ok(packageJson.scripts['build:win'].includes('electron:prepare'));
  assert.ok(packageJson.scripts['build:win'].includes('electron:package:prepare'));
  assert.ok(packageJson.scripts['build:win'].includes('--win nsis --x64'));
  assert.ok(packageJson.scripts['build:win'].includes('--publish never'));
  assert.equal(packageJson.scripts.dev, 'npm run electron:dev');
  assert.equal(packageJson.scripts.build, 'npm run build:linux');
  assert.equal(packageJson.scripts.smoke, 'npm run electron:smoke');
  assert.equal(packageJson.scripts.check, 'npm run typecheck && npm run electron:check');
  assert.equal(
    packageJson.scripts['build:frontend'],
    'tsc --noEmit && node scripts/build-frontend.mjs',
  );
});

test('packaged smoke loads the renderer bridge before shutting sidecars down', () => {
  const mainSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8');
  const smokeStart = mainSource.indexOf('if (smokeMode)');
  const smokeEnd = mainSource.indexOf('await createMainWindow(apiPort);', smokeStart);
  const smoke = mainSource.slice(smokeStart, smokeEnd);

  assert.match(smoke, /createMainWindow\(apiPort, \{show: false\}\)/);
  assert.match(smoke, /document\.querySelector\('#gallery-screen'\)/);
  assert.match(smoke, /window\.vilraDesktop\?\.pickFolder/);
  assert.ok(smoke.indexOf('renderer smoke PASS') < smoke.indexOf('await stopSidecars()'));
  assert.ok(smoke.indexOf('await stopSidecars()') < smoke.indexOf('app.exit(0)'));
  assert.match(mainSource, /process\.env\.VILRA_RELEASE_SMOKE === '1'/);
});

test('native folder picker and file actions use Electron platform APIs', () => {
  const mainSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8');
  const actionSource = fs.readFileSync(
    path.join(repoRoot, 'electron', 'native-file-actions.cjs'),
    'utf8',
  );
  assert.match(mainSource, /properties: \['openDirectory'\]/);
  assert.match(mainSource, /dialog\.showOpenDialog/);
  assert.match(actionSource, /shell\.openPath\(absolutePath\)/);
  assert.match(actionSource, /shell\.showItemInFolder\(absolutePath\)/);
});

test('Electron removes both application and BrowserWindow menus', () => {
  const mainSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8');
  const applicationMenu = mainSource.indexOf('Menu.setApplicationMenu(null);');
  const runtimeStart = mainSource.indexOf('return startRuntime();');
  const windowConstruction = mainSource.indexOf('const window = new BrowserWindow({');
  const windowMenu = mainSource.indexOf('window.setMenu(null);', windowConstruction);
  const windowLoad = mainSource.indexOf('await window.loadURL(', windowConstruction);

  assert.ok(applicationMenu >= 0 && applicationMenu < runtimeStart);
  assert.ok(windowConstruction >= 0 && windowMenu > windowConstruction && windowMenu < windowLoad);
  assert.equal(mainSource.includes('autoHideMenuBar'), false);
});

test('Gallery arrow input bridge is narrow, validated, and trusted', () => {
  const mainSource = fs.readFileSync(path.join(repoRoot, 'electron', 'main.cjs'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(repoRoot, 'electron', 'preload.cjs'), 'utf8');
  const listenerStart = mainSource.indexOf("ipcMain.on('vilra:gallery-arrow-input'");
  const listenerEnd = mainSource.indexOf("ipcMain.handle('vilra:pick-folder'", listenerStart);
  const listener = mainSource.slice(listenerStart, listenerEnd);

  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart);
  assert.ok(listener.indexOf('requireTrustedSender(event)') < listener.indexOf('sendInputEvent'));
  assert.match(listener, /direction !== 'up' && direction !== 'down'/);
  assert.match(listener, /phase !== 'down' && phase !== 'up'/);
  assert.match(listener, /typeof repeat !== 'boolean'/);
  assert.match(listener, /type: phase === 'down' \? 'keyDown' : 'keyUp'/);
  assert.match(listener, /keyCode: direction === 'down' \? 'Down' : 'Up'/);
  assert.match(listener, /modifiers: repeat \? \['isautorepeat'\] : \[\]/);
  assert.match(preloadSource, /sendGalleryArrowInput\(direction, phase, repeat\)/);
  assert.match(preloadSource, /ipcRenderer\.send\(\s*'vilra:gallery-arrow-input'/);
  assert.equal(preloadSource.includes('sendInputEvent'), false);
});

const {app, BrowserWindow, dialog, ipcMain, shell} = require('electron');
const {execFileSync, spawn} = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');

const {resolveSqlitePath} = require('./runtime-paths.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SIDECARS = [
  'imgviewer-api-server',
  'imgviewer-thumb-worker',
  'imgviewer-metadata-worker',
];
const STARTUP_TIMEOUT_MS = 20_000;
const managedProcesses = new Map();

let localOrigin = '';
let shuttingDown = false;
let allowQuit = false;
let fatalExitStarted = false;
let mainWindow = null;

function hostTriple() {
  const override = String(process.env.ELECTRON_TARGET_TRIPLE || '').trim();
  if (override) return override;
  try {
    return execFileSync('rustc', ['--print', 'host-tuple'], {encoding: 'utf8'}).trim();
  } catch {
    const verbose = execFileSync('rustc', ['-vV'], {encoding: 'utf8'});
    const line = verbose.split(/\r?\n/).find(value => value.startsWith('host: '));
    if (!line) throw new Error('Unable to determine the Rust host target triple');
    return line.slice('host: '.length).trim();
  }
}

function targetRoot() {
  const configured = String(process.env.CARGO_TARGET_DIR || '').trim();
  return configured
    ? path.resolve(REPO_ROOT, configured)
    : path.join(REPO_ROOT, 'rust', 'thumb-worker', 'target');
}

function sidecarPath(name) {
  const extension = process.platform === 'win32' ? '.exe' : '';
  return path.join(targetRoot(), hostTriple(), 'release', `${name}${extension}`);
}

function buildId() {
  const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).trim();
  return `${head}${dirty ? '-dirty' : ''}`;
}

function staticDirectory() {
  const configured = String(process.env.TAGIMAGE_STATIC_DIR || '').trim();
  if (!configured) return path.join(REPO_ROOT, 'static');
  return path.isAbsolute(configured) ? configured : path.resolve(REPO_ROOT, configured);
}

function sidecarEnvironment(sqlitePath, staticDir, apiPort) {
  return {
    ...process.env,
    TAGIMAGE_SQLITE_PATH: sqlitePath,
    TAGIMAGE_STATIC_DIR: staticDir,
    TAGIMAGE_PACKAGED_RUNTIME: '1',
    VILRA_BUILD_ID: buildId(),
    IMGVIEWER_RUST_API: '1',
    IMGVIEWER_RUST_API_HOST: '127.0.0.1',
    IMGVIEWER_RUST_API_PORT: String(apiPort),
    IMGVIEWER_METADATA_WORKER: '1',
    IMGVIEWER_METADATA_AUTHORITATIVE: '1',
    IMGVIEWER_THUMB_JOB_MODE: 'queue',
    IMGVIEWER_INLINE_WORKER: '0',
    IMGVIEWER_THUMB_SYNC_FALLBACK: '0',
    IMGVIEWER_THUMB_WORKERS: '4',
    IMGVIEWER_THUMB_WORKER_EXPECTED: '1',
  };
}

function pipeOutput(name, stream, logStream, stderr) {
  const lines = readline.createInterface({input: stream});
  lines.on('line', line => {
    logStream.write(`${line}\n`);
    const output = stderr ? process.stderr : process.stdout;
    output.write(`[${name}] ${line}\n`);
  });
}

function openLog(logDir, name) {
  fs.mkdirSync(logDir, {recursive: true});
  return fs.createWriteStream(path.join(logDir, `${name}.log`), {flags: 'a'});
}

async function waitForSpawn(child, name) {
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', error => reject(new Error(`spawn ${name}: ${error.message}`)));
  });
}

async function runDatabaseInit(executable, env, logDir) {
  const name = 'imgviewer-api-server-init';
  const logStream = openLog(logDir, name);
  const child = spawn(executable, ['--init-db'], {cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
  pipeOutput(name, child.stdout, logStream, false);
  pipeOutput(name, child.stderr, logStream, true);
  try {
    await waitForSpawn(child, name);
  } catch (error) {
    logStream.end();
    throw error;
  }
  const result = await new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  logStream.end();
  if (result.code !== 0) {
    throw new Error(`${name} exited with code ${result.code ?? 'null'} signal ${result.signal || 'none'}`);
  }
}

async function spawnSidecar(name, args, env, logDir) {
  if (shuttingDown) throw new Error(`Runtime shutdown started before spawning ${name}`);
  const executable = sidecarPath(name);
  if (!fs.existsSync(executable)) throw new Error(`Missing Electron sidecar: ${executable}`);
  const logStream = openLog(logDir, name);
  const child = spawn(executable, args, {cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe']});
  pipeOutput(name, child.stdout, logStream, false);
  pipeOutput(name, child.stderr, logStream, true);
  child.once('exit', (code, signal) => {
    logStream.end();
    managedProcesses.delete(name);
    if (!shuttingDown) {
      console.error(`[electron] ${name} exited unexpectedly: code=${code ?? 'null'} signal=${signal || 'none'}`);
      void fatalExit(1);
    }
  });
  try {
    await waitForSpawn(child, name);
  } catch (error) {
    logStream.end();
    throw error;
  }
  if (shuttingDown || child.exitCode !== null || child.signalCode !== null) {
    await stopChild(child);
    throw new Error(`${name} exited during startup`);
  }
  managedProcesses.set(name, child);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise(resolve => setTimeout(() => resolve(true), 2_000)),
  ]);
  if (timedOut && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function stopSidecars() {
  if (shuttingDown) return;
  shuttingDown = true;
  const children = [...managedProcesses.values()];
  await Promise.all(children.map(stopChild));
  managedProcesses.clear();
}

async function fatalExit(code) {
  if (fatalExitStarted) return;
  fatalExitStarted = true;
  await stopSidecars();
  app.exit(code);
}

async function reserveApiPort() {
  const configured = String(process.env.TAGIMAGE_ELECTRON_API_PORT || '').trim();
  if (configured) {
    const port = Number(configured);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid TAGIMAGE_ELECTRON_API_PORT=${configured}`);
    }
    return port;
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForApi(port) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const url = `http://127.0.0.1:${port}/api/status`;
  while (Date.now() < deadline) {
    if (!managedProcesses.has('imgviewer-api-server')) {
      throw new Error('Rust API exited during startup');
    }
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(750)});
      if (response.ok) {
        const status = await response.json();
        if (status.db_ready === true) return;
      }
    } catch {
      // The bounded loop handles startup connection failures.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Rust API did not become ready on 127.0.0.1:${port}`);
}

function requireTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  let origin;
  try {
    origin = new URL(senderUrl).origin;
  } catch {
    throw new Error('Rejected native request from an invalid renderer URL');
  }
  if (!localOrigin || origin !== localOrigin) {
    throw new Error(`Rejected native request from ${origin}`);
  }
}

function registerNativeBridge() {
  ipcMain.handle('vilra:pick-folder', async (event, requestedDefault) => {
    requireTrustedSender(event);
    const options = {title: 'Выберите папку с изображениями', properties: ['openDirectory']};
    if (typeof requestedDefault === 'string' && path.isAbsolute(requestedDefault)) {
      try {
        if (fs.statSync(requestedDefault).isDirectory()) options.defaultPath = requestedDefault;
      } catch {
        // Ignore a stale suggested path and open the native dialog normally.
      }
    }
    const owner = BrowserWindow.fromWebContents(event.sender) || undefined;
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] || null);
  });

  ipcMain.handle('vilra:reveal-path', async (event, targetPath) => {
    requireTrustedSender(event);
    if (typeof targetPath !== 'string' || !targetPath.trim() || !path.isAbsolute(targetPath)) {
      throw new Error('Invalid path');
    }
    if (!fs.existsSync(targetPath)) throw new Error('File does not exist');
    shell.showItemInFolder(targetPath);
  });
}

async function createMainWindow(port) {
  const window = new BrowserWindow({
    title: 'Vilra',
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.once('closed', () => {
    mainWindow = null;
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      if (new URL(targetUrl).origin === localOrigin) return;
    } catch {
      // Invalid navigation is denied below.
    }
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  await window.loadURL(`http://127.0.0.1:${port}/`);
  console.log(`[electron] renderer loaded: ${localOrigin}`);
  return window;
}

async function startRuntime() {
  const sqlitePath = resolveSqlitePath();
  const staticDir = staticDirectory();
  if (!fs.existsSync(path.join(staticDir, 'index.html'))) {
    throw new Error(`Frontend index is missing from ${staticDir}`);
  }
  fs.mkdirSync(path.dirname(sqlitePath), {recursive: true});
  const logDir = path.join(path.dirname(sqlitePath), 'logs');
  const apiPort = await reserveApiPort();
  const env = sidecarEnvironment(sqlitePath, staticDir, apiPort);
  localOrigin = `http://127.0.0.1:${apiPort}`;

  console.log(`[electron] sqlite=${sqlitePath}`);
  console.log(`[electron] static=${staticDir}`);
  console.log(`[electron] api=${localOrigin}`);

  await runDatabaseInit(sidecarPath('imgviewer-api-server'), env, logDir);
  await spawnSidecar(
    'imgviewer-api-server',
    ['--host', '127.0.0.1', '--port', String(apiPort)],
    env,
    logDir,
  );
  await spawnSidecar('imgviewer-thumb-worker', [], env, logDir);
  await spawnSidecar('imgviewer-metadata-worker', [], env, logDir);
  await waitForApi(apiPort);
  console.log(`[electron] API ready: ${localOrigin}`);

  if (process.argv.includes('--smoke')) {
    console.log('[electron] smoke PASS');
    await stopSidecars();
    app.exit(0);
    return;
  }
  await createMainWindow(apiPort);
}

app.setName('Vilra');
registerNativeBridge();

app.on('before-quit', event => {
  if (allowQuit || managedProcesses.size === 0) return;
  event.preventDefault();
  void stopSidecars().finally(() => {
    allowQuit = true;
    app.quit();
  });
});
app.on('window-all-closed', () => app.quit());
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());

app.whenReady()
  .then(startRuntime)
  .catch(error => {
    console.error(`[electron] startup failed: ${error.stack || error}`);
    return fatalExit(1);
  });

const fs = require('node:fs');
const path = require('node:path');

const SIDECAR_NAMES = Object.freeze([
  'imgviewer-api-server',
  'imgviewer-thumb-worker',
  'imgviewer-metadata-worker',
]);
const REQUIRED_STATIC_FILES = Object.freeze([
  'index.html',
  'app.css',
  path.join('dist', 'app.js'),
]);

function resolveRuntimeLayout({
  isPackaged,
  resourcesPath,
  repoRoot,
  targetRoot,
  targetTriple,
  platform = process.platform,
  env = process.env,
}) {
  const extension = platform === 'win32' ? '.exe' : '';
  let workingDirectory;
  let sidecarDirectory;
  let defaultStaticDirectory;
  let buildInfoPath = null;

  if (isPackaged) {
    if (!resourcesPath || !path.isAbsolute(resourcesPath)) {
      throw new Error('Packaged Electron resourcesPath must be absolute');
    }
    workingDirectory = resourcesPath;
    sidecarDirectory = path.join(resourcesPath, 'bin');
    defaultStaticDirectory = path.join(resourcesPath, 'static');
    buildInfoPath = path.join(resourcesPath, 'build-info.json');
  } else {
    if (!repoRoot || !targetRoot || !targetTriple) {
      throw new Error('Development Electron layout requires repoRoot, targetRoot, and targetTriple');
    }
    workingDirectory = repoRoot;
    sidecarDirectory = path.join(targetRoot, targetTriple, 'release');
    defaultStaticDirectory = path.join(repoRoot, 'static');
  }

  const configuredStatic = String(env.TAGIMAGE_STATIC_DIR || '').trim();
  const staticDirectory = configuredStatic
    ? (path.isAbsolute(configuredStatic)
      ? configuredStatic
      : path.resolve(workingDirectory, configuredStatic))
    : defaultStaticDirectory;

  return Object.freeze({
    isPackaged: Boolean(isPackaged),
    workingDirectory,
    staticDirectory,
    buildInfoPath,
    sidecarPath(name) {
      if (!SIDECAR_NAMES.includes(name)) throw new Error(`Unknown Electron sidecar: ${name}`);
      return path.join(sidecarDirectory, `${name}${extension}`);
    },
  });
}

function loadBuildInfo(buildInfoPath) {
  if (!buildInfoPath) throw new Error('Packaged build-info path is unavailable');
  let value;
  try {
    value = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
  } catch (error) {
    throw new Error(`Read packaged build info ${buildInfoPath}: ${error.message}`);
  }
  for (const key of ['gitHead', 'buildId', 'version']) {
    if (typeof value[key] !== 'string' || !value[key].trim()) {
      throw new Error(`Invalid packaged build info field: ${key}`);
    }
  }
  return Object.freeze({
    gitHead: value.gitHead,
    buildId: value.buildId,
    version: value.version,
  });
}

function resolveRuntimeBuildId(layout, developmentResolver) {
  if (layout.isPackaged) return loadBuildInfo(layout.buildInfoPath).buildId;
  if (typeof developmentResolver !== 'function') {
    throw new Error('Development build ID resolver is unavailable');
  }
  return developmentResolver();
}

function requiredPackageResources(resourcesRoot) {
  return [
    ...SIDECAR_NAMES.map(name => path.join(resourcesRoot, 'bin', name)),
    ...REQUIRED_STATIC_FILES.map(file => path.join(resourcesRoot, 'static', file)),
    path.join(resourcesRoot, 'build-info.json'),
  ];
}

function assertPackagedResources(resourcesRoot, platform = process.platform) {
  for (const resource of requiredPackageResources(resourcesRoot)) {
    let stat;
    try {
      stat = fs.statSync(resource);
    } catch {
      throw new Error(`Required Electron package resource is missing: ${resource}`);
    }
    if (!stat.isFile()) throw new Error(`Electron package resource is not a file: ${resource}`);
  }
  if (platform !== 'win32') {
    for (const name of SIDECAR_NAMES) {
      const binary = path.join(resourcesRoot, 'bin', name);
      if ((fs.statSync(binary).mode & 0o111) === 0) {
        throw new Error(`Electron sidecar is not executable: ${binary}`);
      }
    }
  }
  loadBuildInfo(path.join(resourcesRoot, 'build-info.json'));
}

module.exports = {
  REQUIRED_STATIC_FILES,
  SIDECAR_NAMES,
  assertPackagedResources,
  loadBuildInfo,
  requiredPackageResources,
  resolveRuntimeBuildId,
  resolveRuntimeLayout,
};

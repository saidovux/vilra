import {createRequire} from 'node:module';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {dirname, join} from 'node:path';

import {
  binaryNames,
  currentBuildInfo,
  hostTriple,
  releaseBinaryPath,
  repoRoot,
} from './electron-build-context.mjs';

const require = createRequire(import.meta.url);
const {
  REQUIRED_STATIC_FILES,
  assertPackagedResources,
} = require('../electron/runtime-layout.cjs');

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('Electron Round 2A packaging supports Linux x86_64 only');
}

const targetTriple = hostTriple();
if (!targetTriple.includes('linux') || !targetTriple.startsWith('x86_64-')) {
  throw new Error(`Electron AppImage requires an x86_64 Linux Rust target, got ${targetTriple}`);
}

const resourcesRoot = join(repoRoot, 'electron', 'package-resources');
const binDirectory = join(resourcesRoot, 'bin');
const staticDirectory = join(resourcesRoot, 'static');
rmSync(resourcesRoot, {recursive: true, force: true});
mkdirSync(binDirectory, {recursive: true});

for (const name of binaryNames) {
  const source = releaseBinaryPath(name, targetTriple);
  const destination = join(binDirectory, name);
  copyFileSync(source, destination);
  chmodSync(destination, 0o755);
}

for (const relative of REQUIRED_STATIC_FILES) {
  const source = join(repoRoot, 'static', relative);
  const destination = join(staticDirectory, relative);
  mkdirSync(dirname(destination), {recursive: true});
  copyFileSync(source, destination);
}

const buildInfo = currentBuildInfo();
writeFileSync(
  join(resourcesRoot, 'build-info.json'),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
  'utf8',
);

assertPackagedResources(resourcesRoot, process.platform);
process.stdout.write(
  `[electron] package resources ready: ${resourcesRoot} build=${buildInfo.buildId}\n`,
);

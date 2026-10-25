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

const targetTriple = hostTriple();
const supportedPlatform = process.platform === 'linux' || process.platform === 'win32';
if (!supportedPlatform || process.arch !== 'x64') {
  throw new Error(`Vilra packaging supports Linux x86_64 and Windows x64, got ${process.platform} ${process.arch}`);
}
const expectedTarget = process.platform === 'win32'
  ? targetTriple.startsWith('x86_64-') && targetTriple.includes('windows-msvc')
  : targetTriple.startsWith('x86_64-') && targetTriple.includes('linux');
if (!expectedTarget) {
  throw new Error(`Electron ${process.platform} x64 package cannot use Rust target ${targetTriple}`);
}
const binaryExtension = process.platform === 'win32' ? '.exe' : '';

const resourcesRoot = join(repoRoot, 'electron', 'package-resources');
const binDirectory = join(resourcesRoot, 'bin');
const staticDirectory = join(resourcesRoot, 'static');
rmSync(resourcesRoot, {recursive: true, force: true});
mkdirSync(binDirectory, {recursive: true});

for (const name of binaryNames) {
  const source = releaseBinaryPath(name, targetTriple);
  const destination = join(binDirectory, `${name}${binaryExtension}`);
  copyFileSync(source, destination);
  if (process.platform !== 'win32') chmodSync(destination, 0o755);
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

import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';

import {repoRoot} from './electron-build-context.mjs';

const require = createRequire(import.meta.url);
const {assertPackagedResources, loadBuildInfo} = require('../electron/runtime-layout.cjs');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`);
  return process.argv[index + 1];
}

function filesBelow(root) {
  const files = [];
  for (const entry of readdirSync(root, {withFileTypes: true})) {
    const current = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(current));
    else if (entry.isFile()) files.push(current);
  }
  return files;
}

const platform = argument('platform');
if (platform !== 'linux' && platform !== 'win32') {
  throw new Error(`Unsupported release platform: ${platform}`);
}

const resourcesRoot = resolve(argument('resources'));
const artifact = resolve(argument('artifact'));
const expectedHead = argument('expected-head');
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const expectedName = platform === 'win32'
  ? `Vilra_Setup_${packageJson.version}_x64.exe`
  : `Vilra_${packageJson.version}_amd64.AppImage`;

assertPackagedResources(resourcesRoot, platform);
const buildInfo = loadBuildInfo(join(resourcesRoot, 'build-info.json'));
if (buildInfo.version !== packageJson.version) {
  throw new Error(`Packaged version ${buildInfo.version} does not match ${packageJson.version}`);
}
if (buildInfo.gitHead !== expectedHead) {
  throw new Error(`Packaged commit ${buildInfo.gitHead} does not match ${expectedHead}`);
}
if (buildInfo.buildId !== expectedHead.slice(0, 12)) {
  throw new Error(`Release build ID is not clean: ${buildInfo.buildId}`);
}
if (basename(artifact) !== expectedName) {
  throw new Error(`Unexpected artifact name ${basename(artifact)}; expected ${expectedName}`);
}
const artifactStat = statSync(artifact);
if (!artifactStat.isFile() || artifactStat.size === 0) {
  throw new Error(`Release artifact is empty: ${artifact}`);
}

const resourceFiles = filesBelow(resourcesRoot);
for (const file of resourceFiles) {
  if (/\.(?:db|sqlite|sqlite3)$/i.test(file)) {
    throw new Error(`Database file must not be packaged: ${file}`);
  }
}

const textFiles = resourceFiles.filter(file => /\.(?:css|html|js|json)$/i.test(file));
const localPaths = [repoRoot, process.env.HOME, process.env.USERPROFILE]
  .filter(value => typeof value === 'string' && value.length > 3);
for (const file of textFiles) {
  const contents = readFileSync(file, 'utf8');
  const leaked = localPaths.find(value => contents.includes(value));
  if (leaked) throw new Error(`Local build path leaked into ${file}: ${leaked}`);
}

const hash = createHash('sha256').update(readFileSync(artifact)).digest('hex');
process.stdout.write(`${hash}  ${expectedName}\n`);
process.stdout.write(
  `[release] verified ${platform} artifact version=${buildInfo.version} commit=${buildInfo.gitHead}\n`,
);

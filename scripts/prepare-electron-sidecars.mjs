import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rustManifest = join(repoRoot, 'rust', 'Cargo.toml');
const configuredTargetRoot = String(process.env.CARGO_TARGET_DIR || '').trim();
const targetRoot = configuredTargetRoot
  ? resolve(repoRoot, configuredTargetRoot)
  : join(repoRoot, 'rust', 'thumb-worker', 'target');
const binaryNames = [
  'imgviewer-api-server',
  'imgviewer-thumb-worker',
  'imgviewer-metadata-worker',
];

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

const targetTriple = hostTriple();
const extension = targetTriple.includes('windows') ? '.exe' : '';
const gitHead = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();
const buildId = `${gitHead}${dirty ? '-dirty' : ''}`;

execFileSync('cargo', [
  'build',
  '--manifest-path', rustManifest,
  '--release',
  '--target', targetTriple,
  '--target-dir', targetRoot,
  ...binaryNames.flatMap(name => ['--bin', name]),
], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {...process.env, VILRA_BUILD_ID: buildId},
});

for (const name of binaryNames) {
  const binary = join(targetRoot, targetTriple, 'release', `${name}${extension}`);
  if (!existsSync(binary)) throw new Error(`Electron sidecar build is missing: ${binary}`);
  process.stdout.write(`[electron] prepared ${binary} build=${buildId}\n`);
}

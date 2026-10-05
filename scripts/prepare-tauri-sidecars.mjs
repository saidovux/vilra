import {execFileSync} from 'node:child_process';
import {chmodSync, copyFileSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rustManifest = join(repoRoot, 'rust', 'Cargo.toml');
const configuredTargetRoot = String(process.env.CARGO_TARGET_DIR || '').trim();
const targetRoot = configuredTargetRoot
  ? resolve(repoRoot, configuredTargetRoot)
  : join(repoRoot, 'rust', 'thumb-worker', 'target');
const binariesDir = join(repoRoot, 'src-tauri', 'binaries');
const binaryNames = [
  'imgviewer-api-server',
  'imgviewer-thumb-worker',
  'imgviewer-metadata-worker',
];

function hostTriple() {
  const override = String(
    process.env.TAURI_TARGET_TRIPLE || process.env.TAURI_ENV_TARGET_TRIPLE || ''
  ).trim();
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
const windowsTarget = targetTriple.includes('windows');
const extension = windowsTarget ? '.exe' : '';
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

mkdirSync(binariesDir, {recursive: true});
for (const name of binaryNames) {
  const source = join(targetRoot, targetTriple, 'release', `${name}${extension}`);
  const destination = join(binariesDir, `${name}-${targetTriple}${extension}`);
  copyFileSync(source, destination);
  if (!windowsTarget) chmodSync(destination, 0o755);
  process.stdout.write(`[tauri] prepared ${destination} from ${source} build=${buildId}\n`);
}

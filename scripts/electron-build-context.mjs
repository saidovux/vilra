import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const rustManifest = join(repoRoot, 'rust', 'Cargo.toml');
export const binaryNames = [
  'imgviewer-api-server',
  'imgviewer-thumb-worker',
  'imgviewer-metadata-worker',
];

export function electronTargetRoot() {
  const configured = String(process.env.CARGO_TARGET_DIR || '').trim();
  return configured
    ? resolve(repoRoot, configured)
    : join(repoRoot, 'rust', 'thumb-worker', 'target');
}

export function hostTriple() {
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

export function releaseBinaryPath(name, targetTriple = hostTriple()) {
  if (!binaryNames.includes(name)) throw new Error(`Unknown Electron sidecar: ${name}`);
  const extension = targetTriple.includes('windows') ? '.exe' : '';
  return join(electronTargetRoot(), targetTriple, 'release', `${name}${extension}`);
}

export function currentBuildInfo() {
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return {
    gitHead,
    buildId: `${gitHead.slice(0, 12)}${dirty ? '-dirty' : ''}`,
    version: String(packageJson.version),
  };
}

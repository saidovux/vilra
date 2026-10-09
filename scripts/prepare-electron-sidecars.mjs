import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {
  binaryNames,
  currentBuildInfo,
  electronTargetRoot,
  hostTriple,
  releaseBinaryPath,
  repoRoot,
  rustManifest,
} from './electron-build-context.mjs';

const targetTriple = hostTriple();
const targetRoot = electronTargetRoot();
const {buildId} = currentBuildInfo();

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
  const binary = releaseBinaryPath(name, targetTriple);
  if (!existsSync(binary)) throw new Error(`Electron sidecar build is missing: ${binary}`);
  process.stdout.write(`[electron] prepared ${binary} build=${buildId}\n`);
}

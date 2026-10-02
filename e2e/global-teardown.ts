import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..');
const runDir = path.join(repoRoot, '.run');
const runtimeDir = path.join(runDir, 'e2e-runtime');
const logDir = path.join(runDir, 'e2e-logs');
const statePath = path.join(runtimeDir, 'state.json');

function stopApp(): Promise<void> {
  return new Promise(resolve => {
    const child = spawn('./start.sh', ['stop'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TAGIMAGE_RUN_DIR: runtimeDir,
        TAGIMAGE_LOG_DIR: logDir,
      },
      stdio: 'inherit',
    });
    child.on('error', () => resolve());
    child.on('exit', () => resolve());
  });
}

async function globalTeardown(): Promise<void> {
  await stopApp();
  fs.rmSync(statePath, { force: true });
}

export default globalTeardown;

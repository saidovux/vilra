import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..');
const statePath = path.join(repoRoot, '.run', 'e2e-state.json');

function stopApp(): Promise<void> {
  return new Promise(resolve => {
    const child = spawn('./start.sh', ['stop'], {
      cwd: repoRoot,
      env: process.env,
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

import { request } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';

const repoRoot = path.resolve(__dirname, '..');
const runDir = path.join(repoRoot, '.run');
const statePath = path.join(runDir, 'e2e-state.json');
const fixtureDir = path.join(runDir, 'e2e-images');
const sqlitePath = path.join(runDir, 'e2e', 'tagimage.sqlite');
const port = Number(process.env.TAGIMAGE_E2E_PORT || 8765);
const baseURL = process.env.TAGIMAGE_E2E_BASE_URL || `http://127.0.0.1:${port}`;
const imageCount = Number(process.env.TAGIMAGE_E2E_IMAGE_COUNT || 72);

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = (rgb[0] + x * 2) % 256;
      raw[offset + 1] = (rgb[1] + y * 2) % 256;
      raw[offset + 2] = (rgb[2] + x + y) % 256;
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND'),
  ]);
}

function createFixtures(): void {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixtureDir, 'batch-a'), { recursive: true });
  fs.mkdirSync(path.join(fixtureDir, 'batch-b', 'nested'), { recursive: true });
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  fs.rmSync(sqlitePath, { force: true });
  fs.rmSync(`${sqlitePath}-wal`, { force: true });
  fs.rmSync(`${sqlitePath}-shm`, { force: true });

  for (let i = 0; i < imageCount; i += 1) {
    const dir = i % 2 === 0 ? 'batch-a' : path.join('batch-b', 'nested');
    const width = 32 + (i % 5) * 7;
    const height = 32 + (i % 7) * 5;
    const color: [number, number, number] = [
      (40 + i * 17) % 256,
      (90 + i * 29) % 256,
      (150 + i * 43) % 256,
    ];
    fs.writeFileSync(
      path.join(fixtureDir, dir, `fixture-${String(i + 1).padStart(3, '0')}.png`),
      png(width, height, color),
    );
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function waitForImages(): Promise<void> {
  const api = await request.newContext({ baseURL });
  const deadline = Date.now() + 120_000;
  try {
    while (Date.now() < deadline) {
      const status = await api.get('/api/status').catch(() => null);
      if (status?.ok()) {
        const json = await status.json();
        const images = await api.get('/api/images?limit=60&include_total=1');
        if (images.ok()) {
          const data = await images.json();
          const count = Array.isArray(data.items) ? data.items.length : 0;
          const total = Number(data.page?.total || count);
          if (json.db_ready && total >= Math.min(imageCount, 60) && count > 0) return;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  } finally {
    await api.dispose();
  }
  throw new Error('Timed out waiting for e2e fixture images to be indexed');
}

async function globalSetup(): Promise<void> {
  createFixtures();
  const env = {
    ...process.env,
    TAGIMAGE_SQLITE_PATH: sqlitePath,
    IMGVIEWER_THUMB_WORKERS: '2',
    IMGVIEWER_THUMB_WAIT_MS: '50',
    IMGVIEWER_THUMB_POLL_MS: '20',
    IMGVIEWER_STARTUP_TIMEOUT_SEC: '60',
    IMGVIEWER_DB_STARTUP_TIMEOUT_SEC: '30',
  };

  await run('./start.sh', ['stop'], env).catch(() => undefined);
  await run('./start.sh', [
    'start',
    '--build-rust',
    '--strict-rust',
    '--no-open',
    '--port',
    String(port),
    fixtureDir,
  ], env);

  fs.writeFileSync(statePath, JSON.stringify({ baseURL, fixtureDir, sqlitePath }, null, 2));
  await waitForImages();
}

export default globalSetup;

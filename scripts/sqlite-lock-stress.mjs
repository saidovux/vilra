#!/usr/bin/env node

import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import zlib from 'node:zlib';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rustManifest = path.join(repoRoot, 'rust', 'Cargo.toml');
const runCount = Math.max(1, Number(process.env.VILRA_SQLITE_STRESS_RUNS || 1));
const imageCount = Math.max(100, Number(process.env.VILRA_SQLITE_STRESS_IMAGES || 120));
const writeConcurrency = Math.max(1, Number(process.env.VILRA_SQLITE_STRESS_WRITE_CONCURRENCY || 1));
const label = (process.env.VILRA_SQLITE_STRESS_LABEL || 'run').replace(/[^a-zA-Z0-9_-]/g, '-');
const basePort = Number(process.env.VILRA_SQLITE_STRESS_PORT || 8890);
const allowFailure = process.env.VILRA_SQLITE_STRESS_ALLOW_FAILURE === '1';
const labelDir = path.join(repoRoot, '.run', 'sqlite-stress', label);
let activeCleanup = null;

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: {...process.env, ...(options.env || {})},
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout || ''}${result.stderr || ''}` : '';
    fail(`${command} ${args.join(' ')} exited with ${result.status}${detail}`);
  }
  return options.capture ? String(result.stdout).trim() : '';
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function png(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      raw[offset] = (rgb[0] + x * 2) % 256;
      raw[offset + 1] = (rgb[1] + y * 2) % 256;
      raw[offset + 2] = (rgb[2] + x + y) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND'),
  ]);
}

function createFixtures(root) {
  fs.mkdirSync(path.join(root, 'batch-a'), {recursive: true});
  fs.mkdirSync(path.join(root, 'batch-b', 'nested'), {recursive: true});
  for (let index = 0; index < imageCount; index += 1) {
    const relativeDir = index % 2 === 0 ? 'batch-a' : path.join('batch-b', 'nested');
    const width = 32 + (index % 5) * 7;
    const height = 32 + (index % 7) * 5;
    const color = [
      (40 + index * 17) % 256,
      (90 + index * 29) % 256,
      (150 + index * 43) % 256,
    ];
    fs.writeFileSync(
      path.join(root, relativeDir, `stress-${String(index + 1).padStart(3, '0')}.png`),
      png(width, height, color),
    );
  }
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function metrics(samples) {
  const latencies = samples.map(sample => sample.latencyMs).sort((a, b) => a - b);
  const midpoint = Math.floor(latencies.length / 2);
  const median = latencies.length === 0
    ? null
    : latencies.length % 2
      ? latencies[midpoint]
      : (latencies[midpoint - 1] + latencies[midpoint]) / 2;
  return {
    requests: samples.length,
    success: samples.filter(sample => sample.valid).length,
    databaseBusy: samples.filter(sample => sample.databaseBusy).length,
    otherErrors: samples.filter(sample => !sample.valid && !sample.databaseBusy).length,
    medianMs: median,
    p95Ms: percentile(latencies, 0.95),
    maxMs: latencies.length ? latencies.at(-1) : null,
    errors: samples.filter(sample => !sample.valid).map(sample => sample.error).slice(0, 10),
  };
}

async function http(baseUrl, method, route, payload, validate = () => true) {
  const started = performance.now();
  let status = 0;
  let data = null;
  let raw = '';
  try {
    const response = await fetch(baseUrl + route, {
      method,
      headers: payload === undefined ? undefined : {'content-type': 'application/json'},
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    status = response.status;
    raw = await response.text();
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
  } catch (error) {
    raw = String(error?.stack || error);
  }
  const valid = status >= 200 && status < 400 && validate(data, raw);
  return {
    status,
    valid,
    latencyMs: performance.now() - started,
    databaseBusy: /DatabaseBusy|database is locked/i.test(raw),
    error: valid ? null : raw.slice(0, 800),
    data,
  };
}

async function waitForApi(baseUrl, children) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (children.some(child => child.exitCode !== null)) fail('runtime process exited during API startup');
    const response = await http(baseUrl, 'GET', '/api/status');
    if (response.status === 200) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fail('timed out waiting for stress API');
}

async function waitForImages(baseUrl) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await http(baseUrl, 'GET', '/api/images?limit=1&include_total=1');
    const total = Number(response.data?.page?.total || 0);
    if (response.valid && total >= imageCount) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  fail(`timed out waiting for ${imageCount} indexed images`);
}

function spawnRuntime(name, binary, args, env, logDir, runtime) {
  const logPath = path.join(logDir, `${name}.log`);
  const fd = fs.openSync(logPath, 'w');
  const child = spawn(binary, args, {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  child.name = name;
  child.logPath = logPath;
  child.on('exit', (code, signal) => {
    if (!runtime.stopping) runtime.unexpectedExits.push({name, code, signal});
  });
  runtime.children.push(child);
  return child;
}

async function stopRuntime(runtime) {
  runtime.stopping = true;
  for (const child of [...runtime.children].reverse()) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
  }
  const deadline = Date.now() + 5_000;
  while (runtime.children.some(child => child.exitCode === null) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const child of runtime.children) {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  }
}

async function probeSet(baseUrl, count) {
  const groups = {root: [], status: [], images: []};
  for (let index = 0; index < count; index += 1) {
    const [root, status, images] = await Promise.all([
      http(baseUrl, 'GET', '/', undefined, (_data, raw) => raw.includes('<!doctype html>') || raw.includes('<html')),
      http(baseUrl, 'GET', '/api/status'),
      http(baseUrl, 'GET', '/api/images?limit=1&include_total=0'),
    ]);
    groups.root.push(root);
    groups.status.push(status);
    groups.images.push(images);
  }
  return Object.fromEntries(Object.entries(groups).map(([name, samples]) => [name, metrics(samples)]));
}

async function probeWhile(baseUrl, action) {
  let running = true;
  const samples = {root: [], status: [], images: []};
  const probe = (async () => {
    while (running) {
      const [root, status, images] = await Promise.all([
        http(baseUrl, 'GET', '/', undefined, (_data, raw) => raw.includes('<!doctype html>') || raw.includes('<html')),
        http(baseUrl, 'GET', '/api/status'),
        http(baseUrl, 'GET', '/api/images?limit=1&include_total=0'),
      ]);
      samples.root.push(root);
      samples.status.push(status);
      samples.images.push(images);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  })();
  try {
    await action();
  } finally {
    running = false;
    await probe;
  }
  return Object.fromEntries(Object.entries(samples).map(([name, rows]) => [name, metrics(rows)]));
}

async function runOperations(operations, concurrency = writeConcurrency) {
  const samples = new Array(operations.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, operations.length)}, async () => {
    while (next < operations.length) {
      const index = next;
      next += 1;
      const operation = operations[index];
      samples[index] = await operation();
    }
  }));
  return samples;
}

function countOrphanTemps(root) {
  let count = 0;
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) count += countOrphanTemps(item);
    else if (entry.isFile() && entry.name.startsWith('.') && entry.name.endsWith('.tmp')) count += 1;
  }
  return count;
}

function logMatches(logDir, pattern) {
  const matches = [];
  for (const name of fs.readdirSync(logDir)) {
    const logPath = path.join(logDir, name);
    const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (pattern.test(line)) matches.push(`${name}: ${line}`);
      pattern.lastIndex = 0;
    }
  }
  return matches;
}

function helperJson(helper, args) {
  return JSON.parse(run(helper, args, {capture: true}));
}

async function oneRun(index, binaries) {
  const runDir = path.join(labelDir, `run-${index + 1}`);
  const imageRoot = path.join(runDir, 'images');
  const dbPath = path.join(runDir, 'tagimage.sqlite');
  const logDir = path.join(runDir, 'logs');
  const port = basePort + index;
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.mkdirSync(logDir, {recursive: true});
  createFixtures(imageRoot);

  const env = {
    ...process.env,
    TAGIMAGE_SQLITE_PATH: dbPath,
    IMGVIEWER_THUMB_WORKERS: '4',
    IMGVIEWER_THUMB_WORKER_POLL_MS: '750',
    IMGVIEWER_METADATA_POLL_MS: '750',
    IMGVIEWER_METADATA_WORKER: '1',
    IMGVIEWER_METADATA_AUTHORITATIVE: '1',
    IMGVIEWER_THUMB_WORKER_EXPECTED: '1',
  };
  run(binaries.api, ['--init-db'], {env});

  const runtime = {children: [], unexpectedExits: [], stopping: false};
  activeCleanup = () => stopRuntime(runtime);
  const started = performance.now();
  let result;
  try {
    spawnRuntime('api', binaries.api, ['--host', '127.0.0.1', '--port', String(port)], env, logDir, runtime);
    await waitForApi(baseUrl, runtime.children);

    const folder = await http(baseUrl, 'POST', '/api/folder', {path: imageRoot}, data => data?.ok === true);
    if (!folder.valid) fail(`set stress folder failed: ${folder.error}`);
    await waitForImages(baseUrl);

    const metadataSeed = helperJson(binaries.helper, ['seed-metadata', dbPath, String(imageCount)]);
    if (metadataSeed.enqueued !== imageCount || metadataSeed.deduped !== 0) {
      fail(`unexpected metadata seed result: ${JSON.stringify(metadataSeed)}`);
    }
    spawnRuntime('thumb', binaries.thumb, [], env, logDir, runtime);
    spawnRuntime('metadata', binaries.metadata, [], env, logDir, runtime);
    const activeAtWriteStart = helperJson(binaries.helper, ['audit', dbPath]);
    const mixedProbes = await probeSet(baseUrl, 20);

    const imagesResponse = await http(baseUrl, 'GET', '/api/images?limit=60&include_total=1');
    const imageIds = (imagesResponse.data?.items || []).slice(0, 25).map(item => item.id);
    if (imageIds.length < 25) fail(`stress requires 25 image ids, got ${imageIds.length}`);

    const prefix = `stress-${label}-${index + 1}`;
    const createdTags = Array.from({length: 25}, (_, item) => `${prefix}-tag-${item}`);
    const renamedTags = createdTags.map(name => `${name}-renamed`);
    const writeSamples = {};
    let concurrentSessionChecks = 0;

    const concurrentProbes = await probeWhile(baseUrl, async () => {
      writeSamples.tagCreate = await runOperations(createdTags.map(name => () =>
        http(baseUrl, 'POST', '/api/tags', {name}, data => data?.tag?.name === name)
      ));
      writeSamples.tagUpdate = await runOperations(createdTags.map((name, item) => () =>
        http(baseUrl, 'PATCH', `/api/tags/${encodeURIComponent(name)}`, {name: renamedTags[item]},
          data => data?.tag?.name === renamedTags[item])
      ));
      writeSamples.imageTags = await runOperations(imageIds.map((imageId, item) => () =>
        http(baseUrl, 'POST', `/api/tag/${encodeURIComponent(imageId)}`, {tags: [renamedTags[item]]},
          data => data?.user_tags?.includes(renamedTags[item]))
      ));

      writeSamples.mixedBurst = [];
      for (let round = 0; round < 1; round += 1) {
        const burstTag = `${prefix}-burst-${round}`;
        const burst = await Promise.all([
          http(baseUrl, 'POST', '/api/tags', {name: burstTag}, data => data?.tag?.name === burstTag),
          http(baseUrl, 'PATCH', '/api/session', {search_mode: round % 2 === 0 ? 'all' : 'any'}),
          http(baseUrl, 'POST', `/api/tag/${encodeURIComponent(imageIds[round])}`,
            {tags: [renamedTags[round]]}, data => data?.user_tags?.includes(renamedTags[round])),
        ]);
        writeSamples.mixedBurst.push(...burst);
      }

      writeSamples.sessionConcurrency = [];
      for (let round = 0; round < 5; round += 1) {
        const reset = await http(baseUrl, 'PATCH', '/api/session', {
          search_mode: 'any',
          last_image_id: null,
        });
        writeSamples.sessionConcurrency.push(reset);
        if (!reset.valid) continue;
        const pair = await Promise.all([
          http(baseUrl, 'PATCH', '/api/session', {search_mode: 'all'}),
          http(baseUrl, 'PATCH', '/api/session', {last_image_id: imageIds[round]}),
        ]);
        writeSamples.sessionConcurrency.push(...pair);
        const session = await http(baseUrl, 'GET', '/api/session');
        if (pair.every(item => item.valid)
          && session.data?.search_mode === 'all'
          && session.data?.last_image_id === imageIds[round]) {
          concurrentSessionChecks += 1;
        }
      }

      writeSamples.sessionPatch = await runOperations(Array.from({length: 25}, (_, item) => () => {
        const payload = item % 2 === 0
          ? {search_mode: item % 4 === 0 ? 'any' : 'all'}
          : {last_image_id: imageIds[item]};
        return http(baseUrl, 'PATCH', '/api/session', payload, data => {
          if (payload.search_mode) return data?.search_mode === payload.search_mode;
          return data?.last_image_id === payload.last_image_id;
        });
      }));
      writeSamples.thumbRebuild = await runOperations(Array.from({length: 10}, () => () =>
        http(baseUrl, 'POST', '/api/thumbs/rebuild', {stale_only: false, limit: 10},
          data => data?.ok === true)
      ), 2);
    });

    const tags = await http(baseUrl, 'GET', '/api/tags');
    const finalTags = new Set((tags.data?.tags || []).map(tag => tag.name));
    const allRenamedTagsPresent = renamedTags.every(name => finalTags.has(name));
    const queueStarted = performance.now();
    const audit = helperJson(binaries.helper, ['wait-audit', dbPath, '300']);
    const queueDrainSec = (performance.now() - queueStarted) / 1000;
    const workloadCompleted = performance.now();
    const idleProbes = await probeSet(baseUrl, 20);
    const orphanTemps = countOrphanTemps(imageRoot);
    const busyLogs = logMatches(logDir, /DatabaseBusy|database is locked/i);
    const fatalLogs = logMatches(logDir, /panicked|fatal worker|failed to start/i);

    const writes = Object.fromEntries(
      Object.entries(writeSamples).map(([name, samples]) => [name, metrics(samples)]),
    );
    const writeFailures = Object.values(writes).reduce(
      (sum, value) => sum + value.databaseBusy + value.otherErrors,
      0,
    );
    const probes = {idle: idleProbes, mixed: mixedProbes, concurrent: concurrentProbes};
    const probeFailures = Object.values(probes).reduce(
      (total, stage) => total + Object.values(stage).reduce(
        (sum, value) => sum + value.databaseBusy + value.otherErrors,
        0,
      ),
      0,
    );
    const stateClean = ['thumb', 'metadata'].every(type =>
      audit[type].queued === 0 && audit[type].running === 0 && audit[type].failed === 0
    );
    const attemptsClean = ['thumb', 'metadata'].every(type =>
      audit[type].attempts === audit[type].started_events
      && audit[type].attempts === audit[type].succeeded
      && audit[type].succeeded === audit[type].succeeded_events
    );
    const passed = writeFailures === 0
      && probeFailures === 0
      && concurrentSessionChecks === 5
      && allRenamedTagsPresent
      && stateClean
      && attemptsClean
      && audit.metadata.succeeded === imageCount
      && audit.metadata_images_with_dimensions === imageCount
      && audit.duplicate_attempts === 0
      && audit.duplicate_terminal_events === 0
      && audit.stale_running === 0
      && audit.recovery_events === 0
      && orphanTemps === 0
      && busyLogs.length === 0
      && fatalLogs.length === 0
      && runtime.unexpectedExits.length === 0;

    result = {
      run: index + 1,
      label,
      imageCount,
      writeConcurrency,
      port,
      passed,
      durationSec: (performance.now() - started) / 1000,
      queueDrainSec,
      jobsPerSec: (audit.thumb.succeeded + audit.metadata.succeeded) / ((workloadCompleted - started) / 1000),
      metadataSeed,
      activeAtWriteStart,
      writes,
      concurrentSessionChecks: {passed: concurrentSessionChecks, total: 5},
      allRenamedTagsPresent,
      probes,
      audit,
      orphanTemps,
      busyLogCount: busyLogs.length,
      fatalLogCount: fatalLogs.length,
      unexpectedExits: runtime.unexpectedExits,
    };
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  } finally {
    await stopRuntime(runtime);
    activeCleanup = null;
  }
  return result;
}

async function main() {
  fs.rmSync(labelDir, {recursive: true, force: true});
  fs.mkdirSync(labelDir, {recursive: true});

  run('cargo', ['build', '--manifest-path', rustManifest, '--workspace', '--release']);
  run('cargo', [
    'build', '--manifest-path', rustManifest, '--release', '-p', 'tagimage-db',
    '--example', 'sqlite-stress-tool',
  ]);
  const cargoMetadata = JSON.parse(run('cargo', [
    'metadata', '--manifest-path', rustManifest, '--format-version', '1', '--no-deps',
  ], {capture: true}));
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const releaseDir = path.join(cargoMetadata.target_directory, 'release');
  const binaries = {
    api: path.join(releaseDir, `imgviewer-api-server${suffix}`),
    thumb: path.join(releaseDir, `imgviewer-thumb-worker${suffix}`),
    metadata: path.join(releaseDir, `imgviewer-metadata-worker${suffix}`),
    helper: path.join(releaseDir, 'examples', `sqlite-stress-tool${suffix}`),
  };

  const results = [];
  for (let index = 0; index < runCount; index += 1) {
    console.log(`[sqlite-stress] ${label} run ${index + 1}/${runCount}`);
    results.push(await oneRun(index, binaries));
    console.log(JSON.stringify({
      run: index + 1,
      passed: results.at(-1).passed,
      durationSec: results.at(-1).durationSec,
      writes: results.at(-1).writes,
      probes: results.at(-1).probes,
      audit: results.at(-1).audit,
    }));
  }
  const summary = {
    label,
    runCount,
    imageCount,
    writeConcurrency,
    passed: results.every(result => result.passed),
    results,
  };
  fs.writeFileSync(path.join(labelDir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (!summary.passed && !allowFailure) process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (activeCleanup) await activeCleanup();
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  });
}

main().catch(async error => {
  console.error(error?.stack || error);
  if (activeCleanup) await activeCleanup();
  process.exitCode = 1;
});

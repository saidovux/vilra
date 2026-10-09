import {expect, test, type Page} from '@playwright/test';

const problem = {
  id: 7001,
  image_id: 'runtime-problem-image',
  root_path: '/tmp/vilra-runtime-test',
  path: 'broken.jpg',
  absolute_path: '/tmp/vilra-runtime-test/broken.jpg',
  file_name: 'broken.jpg',
  severity: 'error',
  kind: 'decode_error',
  expected_format: 'jpeg',
  detected_format: null,
  size: 100,
  mtime_ns: 1,
  technical_detail: 'fixture',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

async function installProblemRoutes(page: Page): Promise<void> {
  await page.route('**/api/problems/summary', route => route.fulfill({json: {
    total: 1,
    errors: 1,
    warnings: 0,
    latest_updated_at: problem.updated_at,
  }}));
  await page.route('**/api/problems?**', route => route.fulfill({json: {
    items: [problem],
    page: {total: 1, limit: 100, offset: 0, has_more: false},
  }}));
}

async function openProblems(page: Page): Promise<void> {
  await expect(page.locator('#gallery-screen')).toBeVisible({timeout: 60_000});
  await expect(page.locator('.card[data-id]').first()).toBeVisible({timeout: 60_000});
  await page.locator('#settings-toggle').click();
  await page.locator('[data-settings-tab="problems"]').click();
  await expect(page.locator('.problem-row')).toBeVisible();
}

async function diagnosticRuntime(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const diagnostics = (window as Window & {
      __vilraGalleryDiagnostics?: {
        start: () => void;
        stop: () => Promise<void>;
        report: () => object | null;
      };
    }).__vilraGalleryDiagnostics;
    if (!diagnostics) throw new Error('diagnostics unavailable');
    diagnostics.start();
    await diagnostics.stop();
    const report = diagnostics.report() as {session?: {runtime?: string}} | null;
    return String(report?.session?.runtime || '');
  });
}

test('plain browser keeps fallback behavior and browser diagnostics label', async ({page}) => {
  await installProblemRoutes(page);
  await page.goto('/');
  await openProblems(page);

  await expect(page.locator('[data-action="reveal-problem"]')).toHaveText('Копировать путь');
  expect(await diagnosticRuntime(page)).toBe('browser');
});

test('Electron bridge is selected without enabling Tauri-only persistence', async ({page}) => {
  await page.addInitScript(() => {
    const runtime = window as Window & {
      vilraDesktop?: {
        runtime: 'electron';
        pickFolder: (defaultPath?: string) => Promise<string | null>;
        revealPath: (targetPath: string) => Promise<void>;
      };
      __TAURI_INTERNALS__?: object;
      __TAURI__?: {core: {invoke: (command: string) => Promise<never>}};
      __electronCalls?: Array<{method: string; value: string}>;
      __tauriCalls?: string[];
    };
    runtime.__electronCalls = [];
    runtime.__tauriCalls = [];
    runtime.vilraDesktop = {
      runtime: 'electron',
      pickFolder: async defaultPath => {
        runtime.__electronCalls!.push({method: 'pickFolder', value: defaultPath || ''});
        return null;
      },
      revealPath: async targetPath => {
        runtime.__electronCalls!.push({method: 'revealPath', value: targetPath});
      },
    };
    runtime.__TAURI_INTERNALS__ = {};
    runtime.__TAURI__ = {core: {invoke: async command => {
      runtime.__tauriCalls!.push(command);
      throw new Error('Electron must not invoke Tauri');
    }}};
  });
  await installProblemRoutes(page);
  await page.goto('/');
  await expect(page.locator('#gallery-screen')).toBeVisible({timeout: 60_000});
  await page.locator('[data-action="pick-folder"]').click();
  await openProblems(page);

  const reveal = page.locator('[data-action="reveal-problem"]');
  await expect(reveal).toHaveText('Показать в папке');
  await reveal.click();
  expect(await diagnosticRuntime(page)).toBe('Electron/Chromium');

  const calls = await page.evaluate(() => ({
    electron: (window as Window & {__electronCalls?: unknown[]}).__electronCalls || [],
    tauri: (window as Window & {__tauriCalls?: string[]}).__tauriCalls || [],
  }));
  expect(calls.electron).toEqual([
    {method: 'pickFolder', value: ''},
    {method: 'revealPath', value: problem.absolute_path},
  ]);
  expect(calls.tauri).toEqual([]);
});

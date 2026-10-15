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

test('Electron bridge provides folder, reveal, diagnostics, and Chromium labeling', async ({page}) => {
  await page.addInitScript(() => {
    const runtime = window as Window & {
      vilraDesktop?: {
        runtime: 'electron';
        pickFolder: (defaultPath?: string) => Promise<string | null>;
        revealPath: (targetPath: string) => Promise<void>;
        sendGalleryArrowInput: () => void;
        diagnosticsBegin: () => Promise<unknown>;
        diagnosticsCheckpoint: (sessionId: string, reportJson: string) => Promise<unknown>;
        diagnosticsFinalize: (sessionId: string, reportJson: string) => Promise<unknown>;
        diagnosticsStatus: () => Promise<unknown>;
      };
      __electronCalls?: Array<{method: string; value: string}>;
    };
    runtime.__electronCalls = [];
    runtime.vilraDesktop = {
      runtime: 'electron',
      pickFolder: async defaultPath => {
        runtime.__electronCalls!.push({method: 'pickFolder', value: defaultPath || ''});
        return null;
      },
      revealPath: async targetPath => {
        runtime.__electronCalls!.push({method: 'revealPath', value: targetPath});
      },
      sendGalleryArrowInput: () => undefined,
      diagnosticsBegin: async () => {
        runtime.__electronCalls!.push({method: 'diagnosticsBegin', value: ''});
        return {
          session_id: '1700000000-001-123-1',
          diagnostics_dir: '/mock-app-data/diagnostics',
          checkpoint_path: '/mock-app-data/diagnostics/long-scroll.checkpoint.json',
        };
      },
      diagnosticsCheckpoint: async sessionId => {
        runtime.__electronCalls!.push({method: 'diagnosticsCheckpoint', value: sessionId});
        return {checkpoint_path: 'checkpoint.json', bytes: 1};
      },
      diagnosticsFinalize: async sessionId => {
        runtime.__electronCalls!.push({method: 'diagnosticsFinalize', value: sessionId});
        return {
          json_path: '/mock-app-data/diagnostics/long-scroll.json',
          markdown_path: '/mock-app-data/diagnostics/long-scroll.md',
          analysis_error: null,
          bytes: 1,
        };
      },
      diagnosticsStatus: async () => ({
        diagnostics_dir: '/mock-app-data/diagnostics',
        latest_json: null,
        latest_markdown: null,
        checkpoints: 0,
      }),
    };
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

  const calls = await page.evaluate(() => (
    (window as Window & {__electronCalls?: unknown[]}).__electronCalls || []
  ));
  expect(calls).toEqual([
    {method: 'pickFolder', value: ''},
    {method: 'revealPath', value: problem.absolute_path},
    {method: 'diagnosticsBegin', value: ''},
    {method: 'diagnosticsFinalize', value: '1700000000-001-123-1'},
  ]);
});

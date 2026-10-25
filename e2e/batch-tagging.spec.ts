import {expect, test, type APIRequestContext, type Page} from '@playwright/test';

type ImageItem = {
  id: string;
  path: string;
  auto_tags?: string[];
  user_tags?: string[];
};

test.use({viewport: {width: 1366, height: 768}});

async function imageItems(request: APIRequestContext): Promise<ImageItem[]> {
  const response = await request.get('/api/images?limit=200&include_total=1');
  expect(response.ok()).toBeTruthy();
  const payload = await response.json();
  return Array.isArray(payload.items) ? payload.items : [];
}

async function replaceUserTags(
  request: APIRequestContext,
  imageId: string,
  tags: string[],
): Promise<void> {
  const response = await request.post(`/api/tag/${imageId}`, {data: {tags}});
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function selectedCard(page: Page, imageId: string): Promise<void> {
  const card = page.locator(`.card[data-id="${imageId}"]`);
  await expect(card).toBeVisible({timeout: 30_000});
  await card.click({modifiers: ['Control']});
}

test('batch tag panel applies atomic mixed changes and preserves selection on failure', async ({page}) => {
  test.setTimeout(90_000);
  const initialSession = await (await page.request.get('/api/session')).json();
  const initialImages = await imageItems(page.request);
  expect(initialImages.length).toBeGreaterThanOrEqual(2);
  const targets = initialImages.slice(0, 2);
  const originalTags = new Map(targets.map(image => [image.id, [...(image.user_tags || [])]]));
  const originalAutoTags = new Map(targets.map(image => [image.id, [...(image.auto_tags || [])]]));
  const suffix = `${Date.now()}`;
  const mixedTag = `batch-mixed-${suffix}`;
  const removeTag = `batch-remove-${suffix}`;
  const keepTag = `batch-keep-${suffix}`;
  const addedTag = `batch-added-${suffix}`;
  const secondAddedTag = `batch-added-second-${suffix}`;
  const failedTag = `batch-failed-${suffix}`;
  const createdTags = [mixedTag, removeTag, keepTag, addedTag, secondAddedTag, failedTag];
  let batchRequests = 0;
  let singleTagRequests = 0;
  let failureRouteInstalled = false;

  try {
    await replaceUserTags(page.request, targets[0].id, [
      ...(originalTags.get(targets[0].id) || []), mixedTag, removeTag, keepTag,
    ]);
    await replaceUserTags(page.request, targets[1].id, [
      ...(originalTags.get(targets[1].id) || []), removeTag, keepTag,
    ]);

    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() !== 'POST') return;
      if (url.pathname === '/api/images/tags/batch') batchRequests += 1;
      else if (url.pathname.startsWith('/api/tag/')) singleTagRequests += 1;
    });

    await page.goto('/');
    const tabsBefore = await page.locator('#tabs .tab').count();
    await page.locator('[data-action="add-tab"]').click();
    await expect(page.locator('#tabs .tab')).toHaveCount(tabsBefore + 1);
    await selectedCard(page, targets[0].id);
    await selectedCard(page, targets[1].id);
    await expect(page.locator('#selection-count')).toHaveText('2');
    await page.locator('[data-action="toggle-batch-tags"]').click();
    await expect(page.locator('#batch-tag-panel')).toHaveClass(/open/);

    const mixed = page.locator(`[data-action="toggle-batch-remove"][data-tag="${mixedTag}"]`);
    await expect(mixed.locator('.tag-coverage')).toHaveText('1/2');
    await mixed.click();
    await page.locator(`[data-action="toggle-batch-remove"][data-tag="${removeTag}"]`).click();
    await page.locator('#batch-tag-input').fill(addedTag);
    await page.locator('#batch-tag-input').press('Enter');
    await page.locator('#batch-tag-input').fill(secondAddedTag);
    await page.locator('[data-action="queue-batch-tag"]').click();

    const firstBatch = page.waitForResponse(response =>
      response.url().endsWith('/api/images/tags/batch') && response.request().method() === 'POST',
    );
    await page.locator('#batch-tag-apply').click();
    expect((await firstBatch).ok()).toBeTruthy();
    await expect(page.locator('#batch-tag-status')).toContainText('Обновлено: 2');
    await expect(page.locator('#selection-count')).toHaveText('2');
    expect(batchRequests).toBe(1);
    expect(singleTagRequests).toBe(0);

    let updated = await imageItems(page.request);
    for (const target of targets) {
      const image = updated.find(item => item.id === target.id);
      expect(image?.user_tags).toContain(addedTag);
      expect(image?.user_tags).toContain(secondAddedTag);
      expect(image?.user_tags).toContain(keepTag);
      expect(image?.user_tags).not.toContain(removeTag);
      expect(image?.user_tags).not.toContain(mixedTag);
      expect(image?.auto_tags || []).toEqual(originalAutoTags.get(target.id) || []);
    }

    const filter = page.locator(`[data-sidebar-tag="${addedTag}"]`);
    await expect(filter).toBeVisible();
    await filter.click();
    await expect(page.locator(`.card[data-id="${targets[0].id}"]`)).toBeVisible();
    await expect(page.locator(`.card[data-id="${targets[1].id}"]`)).toBeVisible();
    await page.locator(`[data-action="toggle-batch-remove"][data-tag="${addedTag}"]`).click();
    const secondBatch = page.waitForResponse(response =>
      response.url().endsWith('/api/images/tags/batch') && response.request().method() === 'POST',
    );
    await page.locator('#batch-tag-apply').click();
    expect((await secondBatch).ok()).toBeTruthy();
    await expect(page.locator(`.card[data-id="${targets[0].id}"]`)).toHaveCount(0);
    await expect(page.locator('#selection-count')).toHaveText('2');
    expect(batchRequests).toBe(2);

    await page.route('**/api/images/tags/batch', route => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({detail: 'simulated batch conflict'}),
    }));
    failureRouteInstalled = true;
    await page.locator('#batch-tag-input').fill(failedTag);
    await page.locator('#batch-tag-input').press('Enter');
    await page.locator('#batch-tag-apply').click();
    await expect(page.locator('#batch-tag-status')).toContainText('simulated batch conflict');
    await expect(page.locator('#selection-count')).toHaveText('2');
    await expect(page.locator(`[data-action="cancel-batch-add"][data-tag="${failedTag}"]`))
      .toBeVisible();
    expect(batchRequests).toBe(3);
    expect(singleTagRequests).toBe(0);

    updated = await imageItems(page.request);
    expect(updated.find(item => item.id === targets[0].id)?.user_tags).not.toContain(failedTag);
  } finally {
    if (failureRouteInstalled) await page.unroute('**/api/images/tags/batch');
    for (const target of targets) {
      await replaceUserTags(page.request, target.id, originalTags.get(target.id) || [])
        .catch(() => undefined);
    }
    for (const tag of createdTags) {
      await page.request.delete(`/api/tags/${encodeURIComponent(tag)}`).catch(() => undefined);
    }
    await page.request.patch('/api/session', {data: {
      search_tags: initialSession.search_tags || [],
      search_mode: initialSession.search_mode || 'any',
      tabs: initialSession.tabs || [],
      active_tab_id: initialSession.active_tab_id || null,
      last_image_id: initialSession.last_image_id || null,
    }}).catch(() => undefined);
  }
});

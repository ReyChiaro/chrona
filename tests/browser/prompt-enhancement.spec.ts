import { test, expect } from '@playwright/test';

test('configure official enhancement, keep credentials private, and choose the per-video switch', async ({ page }) => {
  let savedKey = '';
  const config = { enabled: false, baseUrl: 'https://api.minimax.cn', model: 'MiniMax-H3', hasApiKey: false, timeoutSeconds: 300, pollSeconds: 3 };
  await page.route('**/api/render/prompt-enhancement/status', route => route.fulfill({ json: {
    configured: Boolean(savedKey), defaultEnabled: config.enabled, label: 'MiniMax H3-Context-IR',
  } }));
  await page.route('**/api/render/prompt-enhancement', route => {
    if (route.request().method() === 'PUT') {
      const value = route.request().postDataJSON(); savedKey = value.apiKey || savedKey;
      Object.assign(config, { enabled: value.enabled, baseUrl: value.baseUrl, model: value.model, hasApiKey: Boolean(savedKey),
        timeoutSeconds: value.timeoutSeconds, pollSeconds: value.pollSeconds });
    }
    return route.fulfill({ json: config });
  });
  await page.route('**/api/render/prompt-enhancement/test', route => {
    expect(route.request().postDataJSON().apiKey).toBe('minimax-test-secret');
    return route.fulfill({ json: { model: 'MiniMax-H3', latencyMs: 1200, prompt: 'integrated_multimodal_description: A photoreal forest.' } });
  });
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await page.locator('#video-settings-toggle').click();
  await expect(page.locator('#prompt-enhancement-enabled')).toBeDisabled();
  await page.locator('#enhancement-settings summary').first().click();
  await expect(page.locator('#enhancement-unlock-form')).toHaveCount(0);
  await expect(page.locator('#enhancement-access-token')).toHaveCount(0);
  await expect(page.locator('#enhancement-settings-form')).toBeVisible();
  await page.locator('#enhancement-api-key').fill('minimax-test-secret');
  await page.locator('#enhancement-default').check();
  await page.locator('#enhancement-test').click();
  await expect(page.locator('#enhancement-status')).toContainText('增强成功');
  await expect(page.locator('#enhancement-preview')).not.toHaveAttribute('open');
  // Testing must not erase the unsaved credential before Save.
  await page.locator('#enhancement-save').click();
  await expect(page.locator('#enhancement-status')).toContainText('配置已保存');
  expect(savedKey).toBe('minimax-test-secret');
  await expect(page.locator('#enhancement-api-key')).toHaveValue('');
  await expect(page.locator('#prompt-enhancement-enabled')).toBeEnabled();
  await page.locator('#prompt-enhancement-enabled').check();
  const storage = await page.evaluate(async () => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain('minimax-test-secret');
  await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  await page.locator('#video-settings-toggle').click();
  await expect(page.locator('#prompt-enhancement-enabled')).toBeChecked();
  await page.locator('#prompt-enhancement-enabled').uncheck();
  await expect(page.locator('#prompt-enhancement-enabled')).not.toBeChecked();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#enhancement-settings summary').first().click();
  await expect(page.locator('#enhancement-settings-form')).toBeVisible();
  expect(await page.locator('#render-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  expect(await page.evaluate(async () => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/prompt-enhancement-mobile.png', fullPage: true });
});

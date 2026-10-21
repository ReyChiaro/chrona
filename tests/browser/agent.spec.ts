import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('configure an API agent without a server token, create an object, preserve undo and keep credentials out of browser storage', async ({ page, request }) => {
  const recipe = JSON.parse(await readFile(new URL('../fixtures/stone-well.json', import.meta.url), 'utf8')); recipe.version = `1.0.${Date.now()}`;
  let receivedKey = '', api = false;
  const configuration = { enabled: false, baseUrl: '', model: '', hasApiKey: false, timeoutSeconds: 180, maxRounds: 8, configured: false, mode: 'disabled', protocol: 'chat-completions' };
  await page.route('**/api/content/agent/status', route => route.fulfill({ json: { mode: api ? 'api' : 'disabled', model: api ? configuration.model : '', configured: api, protocol: 'chat-completions' } }));
  await page.route('**/api/content/agent', route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); receivedKey = body.apiKey || receivedKey;
      Object.assign(configuration, { ...body, hasApiKey: Boolean(receivedKey), configured: Boolean(body.baseUrl && body.model), mode: body.enabled ? 'api' : 'disabled' });
      delete (configuration as Record<string, unknown>).apiKey; api = body.enabled;
    }
    return route.fulfill({ json: configuration });
  });
  await page.route('**/api/content/agent/test', route => route.fulfill({ json: { ok: true, model: 'test-code-model', latencyMs: 12 } }));
  await page.route('**/api/content/edit', async route => {
    expect(api).toBe(true); const body = route.request().postDataJSON();
    if (body.prompt === '问一个问题') return route.fulfill({ json: { mode: 'api', model: 'test-code-model', trace: [], message: '希望井盖使用什么颜色？' } });
    const source = `export default defineContent(${JSON.stringify(recipe)});`;
    const draft = await request.post('/api/content/validate', { data: { source, config: body.config } }); expect(draft.ok()).toBeTruthy();
    const release = await request.post('/api/content/publish', { data: { id: (await draft.json()).id } }); expect(release.ok()).toBeTruthy();
    return route.fulfill({ json: { mode: 'api', model: 'test-code-model', trace: [{ tool: 'write_plugin', status: 'ok' }], release: await release.json(),
      plan: { requestId: body.requestId, worldId: body.worldId, action: 'create', label: '新增苔石水井', point: body.selection.point, asset: 'well', constraint: 'mossy stone well', referenceIds: [] } } });
  });
  const accessRequests: string[] = [];
  page.on('request', request => { if (/\/agent\/(?:unlock|lock)$/.test(new URL(request.url()).pathname)) accessRequests.push(request.url()); });
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await page.locator('#composer-toggle').click(); await page.locator('#composer-agent-settings').click();
  await expect(page.locator('#agent-unlock-form')).toHaveCount(0);
  await expect(page.locator('#agent-access-token')).toHaveCount(0);
  await expect(page.locator('#agent-lock')).toHaveCount(0);
  await expect(page.locator('#agent-settings')).not.toContainText('chrona.authoring.agents.access');
  await expect(page.locator('#agent-settings-form')).toBeVisible();
  await page.screenshot({ path: 'test-results/agent-settings-no-token.png', fullPage: true });
  await page.locator('#agent-enabled').check(); await page.locator('#agent-base-url').fill('https://provider.example/v1');
  await page.locator('#agent-model').fill('test-code-model'); await page.locator('#agent-api-key').fill('test-provider-secret');
  await page.locator('#agent-test').click(); await expect(page.locator('#agent-settings-status')).toContainText('工具调用可用');
  await page.locator('#agent-save').click(); await expect(page.locator('#agent-settings-status')).toContainText('已启用代码模型');
  expect(receivedKey).toBe('test-provider-secret'); await expect(page.locator('#agent-api-key')).toHaveValue('');
  expect(await page.evaluate(async () => JSON.stringify({ ...localStorage }))).not.toContain('test-provider-secret');
  await page.keyboard.press('Escape'); await expect(page.locator('#agent-settings')).not.toBeVisible();
  await expect(page.locator('#composer-prompt')).toBeFocused(); await expect(page.locator('#composer-agent-mode')).toContainText('test-code-model');
  await page.evaluate(async () => {
    const r = window.chrona.runtime; await r.pause(true);
    for (const c of r.chunks.active.values()) for (let x = c.center.x - 15; x < c.center.x + 15; x += 4) for (let z = c.center.z - 15; z < c.center.z + 15; z += 4) {
      const y = r.groundHeight(x, z);
      if (y <= r.config.terrain.waterLevel + 1 || [...r.chunks.assets.values()].some(a => Math.hypot(a.x - x, a.z - z) < 8)) continue;
      await r.teleport(x, z + 6, y + 3); window.chrona.editor.select({ kind: 'ground', label: '空地', point: { x, y, z } }); return;
    }
    throw new Error('No clear anchor');
  });
  await page.locator('#composer-prompt').fill('新增一座苔石水井'); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(async () => [...window.chrona.runtime.chunks.assets.values()].some(a => a.design?.label === '苔石水井'))).toBe(true);
  await expect(page.locator('#composer-messages')).toContainText('已应用编辑');
  await page.locator('#composer-undo').click();
  await expect.poll(() => page.evaluate(async () => [...window.chrona.runtime.chunks.assets.values()].some(a => a.design?.label === '苔石水井'))).toBe(false);
  const revision = await page.evaluate(async () => window.chrona.runtime.content.state.revision);
  await page.locator('#composer-prompt').fill('问一个问题'); await page.locator('#composer-send').click();
  await expect(page.locator('#composer-messages')).toContainText('井盖使用什么颜色');
  expect(await page.evaluate(async () => window.chrona.runtime.content.state.revision)).toBe(revision);
  await page.locator('#composer-agent-settings').click(); await page.locator('#agent-enabled').uncheck(); await page.locator('#agent-save').click();
  await expect(page.locator('#agent-settings-status')).toContainText('已停用');
  await page.keyboard.press('Escape'); await expect(page.locator('#composer-agent-mode')).toContainText('请配置代码模型');
  expect(accessRequests).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#composer-agent-settings').click(); await expect(page.locator('#agent-settings-form')).toBeVisible();
  expect(await page.locator('#agent-settings').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
  expect(await page.evaluate(async () => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

import { test, expect } from '@playwright/test';
import { regionalFixture } from '../fixtures/regional-scenes';

test('regional chat reports measured preflight, visits new terrain, moves cars and preserves old chunks on reload', async ({ page, request }) => {
  // Only the upstream author is substituted; compilation, publication, browser world and Rapier are real.
  await page.route('**/api/content/edit', async route => {
    const body = route.request().postDataJSON(), pack = regionalFixture('city', body.context.authoring.site.center);
    pack.version = `1.0.${Date.now()}`;
    const source = `export default defineContent(${JSON.stringify(pack)});`;
    const draft = await request.post('/api/content/validate', { data: { source, config: body.config, context: { prompt: body.prompt, protectedChunks: body.context.authoring.protectedChunks } } });
    expect(draft.ok()).toBeTruthy();
    const release = await request.post('/api/content/publish', { data: { id: (await draft.json()).id } });
    expect(release.ok()).toBeTruthy();
    await route.fulfill({ json: { mode: 'api', trace: [], release: await release.json(), plan: { requestId: body.requestId, worldId: body.worldId,
      action: 'future', label: '独立城市区域', intent: body.prompt, referenceIds: [] } } });
  });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await page.evaluate(async () => { const r = window.chrona.runtime; await r.pause(true); await r.applyRuntimeConfig({ ...r.config, loadRange: 3, clock: { ...r.config.clock, timeScale: 1 } }); });
  const old = await page.evaluate(async () => window.chrona.snapshot().chunks);
  await page.locator('#composer-toggle').click(); await page.locator('#composer-prompt').fill('前方生成城市，包含摩天大楼、道路和行驶的汽车');
  await page.locator('#composer-send').click();
  await expect(page.locator('#composer-messages')).toContainText('通过生成预检', { timeout: 30000 });
  await expect(page.locator('#composer-messages')).toContainText('旧区域保持原样');
  await expect(page.locator('#composer-region-visit')).toBeVisible();
  expect(await page.evaluate(async () => window.chrona.snapshot().chunks)).toEqual(old);
  await page.locator('#composer-region-visit').click();
  await expect(page.locator('#scene-composer')).toBeHidden();
  await expect.poll(() => page.evaluate(async () => [...window.chrona.runtime.chunks.assets.values()].filter(a => a.role === 'building').length)).toBeGreaterThanOrEqual(4);
  await expect.poll(() => page.evaluate(async () => window.chrona.runtime.traffic.assets.size)).toBeGreaterThanOrEqual(2);
  const positions = await page.evaluate(async () => { const r = window.chrona.runtime; await r.pause(false); return [...r.traffic.assets].map(([id, a]) => ({ id, x: a.x, z: a.z })); });
  await expect.poll(() => page.evaluate(async before => before.filter(a => { const now = window.chrona.runtime.traffic.assets.get(a.id); return now && Math.hypot(now.x - a.x, now.z - a.z) > 1; }).length, positions), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  await page.evaluate(async () => { await window.chrona.runtime.pause(true); return window.chrona.save(); });
  const fingerprints = await page.evaluate(async () => window.chrona.snapshot().chunks);
  await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  const restored = await page.evaluate(async () => window.chrona.snapshot().chunks);
  for (const c of fingerprints) expect(restored.find(p => p.q === c.q && p.r === c.r)?.fingerprint).toBe(c.fingerprint);
  expect(errors).toEqual([]);
});

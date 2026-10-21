import { test, expect } from '@playwright/test';
import { waterFixture } from '../fixtures/water-scene';

test('ocean chat publishes native coast, all views load, video context identifies water, and revisits retain the surface', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/content/edit', async route => {
    const body = route.request().postDataJSON(), pack = waterFixture(body.context.authoring.site.center, body.config.terrain.waterLevel);
    pack.version = `1.0.${Date.now()}`;
    const source = `export default defineContent(${JSON.stringify(pack)});`;
    const validation = await request.post('/api/content/validate', { data: { source, config: body.config, context: { prompt: body.prompt, protectedChunks: body.context.authoring.protectedChunks } } });
    expect(validation.ok()).toBeTruthy(); const draft = await validation.json();
    expect(draft.report.completion.water.components).toBe(1);
    const release = await request.post('/api/content/publish', { data: { id: draft.id } }); expect(release.ok()).toBeTruthy();
    await route.fulfill({ json: { mode: 'api', release: await release.json(), trace: [], plan: {
      requestId: body.requestId, worldId: body.worldId, action: 'future', label: '连续海岸', referenceIds: [], intent: body.prompt } } });
  });
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  const before = await page.evaluate(async () => { const r = window.chrona.runtime; await r.pause(true); return r.snapshot(); });
  await page.locator('#composer-toggle').click(); await page.locator('#composer-prompt').fill('前方生成海洋、沙滩和海带水草'); await page.locator('#composer-send').click();
  await expect(page.locator('#composer-messages')).toContainText('统一海平面');
  await page.locator('#composer-region-visit').click();
  await page.evaluate(async () => {
    const r = window.chrona.runtime, center = r.content.state.packages.find(p => p.region?.water)!.region!.center;
    await r.applyRuntimeConfig({ ...r.config, loadRange: 4 }); await r.teleport(center.x, center.z + 85);
    await r.setCameraPose({ yaw: 0 }); await r.setCameraPose({ pitch: -0.18 });
  });
  await expect.poll(() => page.evaluate(async () => window.chrona.content.inspect().distantChunks.some(c => c.biome === 'ocean'))).toBe(true);
  await expect.poll(() => page.evaluate(async () => window.chrona.overview().workerError)).toBe('');
  await page.waitForTimeout(1200);
  await page.locator('#first-canvas').screenshot({ path: test.info().outputPath('native-coast.png') });
  await page.evaluate(async () => window.chrona.save()); const saved = await page.evaluate(async () => window.chrona.snapshot());
  await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  const restored = await page.evaluate(async () => window.chrona.snapshot());
  for (const c of saved.chunks) expect(restored.chunks.find(p => p.q === c.q && p.r === c.r)?.fingerprint).toBe(c.fingerprint);
  for (const c of before.chunks) expect(restored.chunks.find(p => p.q === c.q && p.r === c.r)?.fingerprint).toBe(c.fingerprint);
  expect(errors).toEqual([]);
});

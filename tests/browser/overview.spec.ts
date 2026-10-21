import { test, expect } from '@playwright/test';

test('overview retains explored chunks independently, respects cache budgets, and restores history', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await page.evaluate(async () => { await window.chrona.runtime.pause(true); });
  await expect.poll(() => page.evaluate(async () => window.chrona.overview().visibleTerrainChunks)).toBe(7);
  const original = await page.evaluate(async () => window.chrona.snapshot());
  await page.evaluate(async () => { await window.chrona.teleport(160, 40); await window.chrona.teleport(0, 0); });
  await expect(page.locator('#global-canvas')).toHaveAttribute('data-explored-chunks', '14');
  await expect.poll(() => page.evaluate(async keys => window.chrona.overview().detailKeys.some(key => !keys.includes(key)), original.chunks.map(chunk => `${chunk.q},${chunk.r}`))).toBe(true);
  await expect.poll(() => page.evaluate(async () => window.chrona.overview().pending)).toBe(0);
  const before = await page.evaluate(async () => ({
    stats: window.chrona.overview(), snapshot: window.chrona.snapshot(),
    bodies: window.chrona.runtime.metrics.simulationChunks,
  }));
  expect(before.stats.exploredChunks).toBe(14); expect(before.stats.physicsChunks).toBe(7);
  expect(before.stats.pointChunks).toBe(14); expect(before.stats.workerError).toBe('');
  expect(before.stats.detailKeys.some(key => !windowKeySet(original.chunks).has(key))).toBe(true);
  expect(before.stats.cacheBytes).toBeLessThanOrEqual(before.stats.cacheLimitBytes);
  const fingerprints = await page.evaluate(async () => window.chrona.observe().activeChunks);
  await page.locator('#overview-reset').click();
  await expect.poll(() => page.evaluate(async () => window.chrona.overview().cacheHits)).toBeGreaterThan(before.stats.cacheHits);
  const after = await page.evaluate(async () => ({ snapshot: window.chrona.snapshot(), bodies: window.chrona.runtime.metrics.simulationChunks }));
  expect(after.snapshot.chunks).toEqual(before.snapshot.chunks);
  expect(after.snapshot.simulation).toEqual(before.snapshot.simulation); expect(after.bodies).toBe(before.bodies);
  await page.evaluate(async camera => {
    const r = window.chrona.runtime; await r.applyRuntimeConfig({ ...r.config, presentation: { ...r.config.presentation, overviewDetailChunks: 8, overviewCacheMB: 4 } });
    for (let i = 1; i <= 12; i++) await window.chrona.teleport(i * 100, i % 2 * 40);
    await window.chrona.teleport(camera.x, camera.z, camera.y);
  }, original.camera);
  await page.locator('#overview-reset').click();
  await expect.poll(() => page.evaluate(async () => window.chrona.overview().cacheBytes)).toBeLessThanOrEqual(4 * 1024 * 1024);
  await expect.poll(() => page.evaluate(async () => window.chrona.overview().visibleTerrainChunks)).toBeLessThanOrEqual(8);
  const stats = await page.evaluate(async () => window.chrona.overview());
  expect(stats.exploredChunks).toBeGreaterThan(40); expect(stats.physicsChunks).toBe(7);
  expect(stats.pointChunks).toBe(stats.exploredChunks); expect(stats.workerError).toBe('');
  expect(await page.evaluate(async () => window.chrona.observe().activeChunks)).toEqual(fingerprints);
  await page.screenshot({ path: 'test-results/explored-overview.png', fullPage: true });
  await page.evaluate(async () => window.chrona.save());
  await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  await expect.poll(() => page.evaluate(async () => window.chrona.overview().exploredChunks)).toBe(stats.exploredChunks);
  await expect.poll(() => page.evaluate(async () => window.chrona.overview().pending)).toBe(0);
  expect(await page.evaluate(async () => window.chrona.overview().workerError)).toBe('');
  expect(errors).toEqual([]);
});

function windowKeySet(chunks: { q: number; r: number }[]) { return new Set(chunks.map(chunk => `${chunk.q},${chunk.r}`)); }

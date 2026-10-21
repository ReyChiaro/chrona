import { test, expect } from '@playwright/test';

test('landform settings use the new recipe and changing erosion saves the prior world', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await page.evaluate(async () => { await window.chrona.runtime.pause(true); });
  const original = await page.evaluate(async () => window.chrona.snapshot());
  expect(original.generatorVersion).toBe('hex-biomes@5');
  expect(original.config.terrain.mountainScale).toBe(400);
  await page.locator('#settings-toggle').click();
  for (const [name, value] of [['terrain.continentalScale', '900'], ['terrain.erosionScale', '460'], ['terrain.foothillSlope', '0.45'], ['terrain.hillHeight', '12'], ['population.villageSpacing', '260'], ['population.roadDepth', '4']]) {
    await expect(page.locator(`[name="${name}"]`)).toHaveValue(value);
  }
  await page.locator('[name="terrain.erosionScale"]').fill('660');
  await page.locator('[name="terrain.erosionScale"]').dispatchEvent('input');
  await page.locator('#settings-form button[type=submit]').click();
  await expect(page.locator('#settings')).toBeHidden();
  const next = await page.evaluate(async () => window.chrona.snapshot());
  expect(next.id).not.toBe(original.id); expect(next.config.terrain.erosionScale).toBe(660);
  expect(next.config.terrain.mountainHeight).toBe(original.config.terrain.mountainHeight);
  const saved = await (await page.request.get(`/api/worlds/${original.id}`)).json();
  expect(saved.chunks).toEqual(original.chunks); expect(saved.config).toEqual(original.config);
  await page.evaluate(async () => window.chrona.save());
  await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  expect(await page.evaluate(async () => window.chrona.snapshot().id)).toBe(next.id);
  expect(await page.evaluate(async () => window.chrona.snapshot().config.terrain.erosionScale)).toBe(660);
});

test('colored terrain and contours cover explored areas; world state controls preserve paused physics', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await expect.poll(() => page.locator('#map-canvas').getAttribute('data-rendered-chunks')).toBe('7');
  const before = await page.locator('#map-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL());
  await page.locator('#map-contours').check();
  await expect(page.locator('#map-canvas')).toHaveAttribute('data-contours', 'true');
  await expect.poll(() => page.locator('#map-canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL())).not.toBe(before);
  await page.evaluate(async () => { await window.chrona.teleport(300, 120); await window.chrona.teleport(0, 0); });
  await expect.poll(() => page.locator('#map-canvas').getAttribute('data-rendered-chunks')).toBe('14');
  await expect(page.locator('#loaded-stat')).toHaveText('加载 7');
  await page.locator('#world-state-toggle').click();
  await expect(page.locator('#world-state-summary')).toContainText('固定物理频率');
  await page.locator('#state-pause').click();
  const tick = await page.evaluate(async () => window.chrona.observe().tick);
  await page.waitForTimeout(200);
  expect(await page.evaluate(async () => window.chrona.observe().tick)).toBe(tick);
  const count = await page.evaluate(async () => window.chrona.snapshot().simulation.entities.length);
  await page.locator('#state-drop').click();
  const snapshot = await page.evaluate(async () => window.chrona.snapshot());
  expect(snapshot.simulation.entities).toHaveLength(count);
  await page.evaluate(() => window.chrona.runtime.pause(false));
  await expect.poll(() => page.evaluate(() => window.chrona.snapshot().simulation.entities.length)).toBe(count + 1);
  await page.evaluate(() => window.chrona.runtime.pause(true));
  await page.evaluate(async () => window.chrona.save());
  await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  const restored = await page.evaluate(async () => window.chrona.snapshot());
  expect(restored.simulation.entities).toHaveLength(count + 1);
  expect(restored.simulation.paused).toBe(true);
});

import { test, expect } from '@playwright/test';
test('worker continues independently of painting and additional world tabs are read-only', async ({ page, context }) => {
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await page.evaluate(() => window.chrona.save());
  const id = await page.evaluate(() => window.chrona.runtime.id);
  const second = await context.newPage(); await second.goto(`/?world=${id}`); await second.waitForFunction(() => window.chrona?.ready);
  expect(await second.evaluate(() => window.chrona.runtime.readOnly)).toBe(true);
  expect(await second.evaluate(async () => { try { await window.chrona.teleport(10,10); return ''; } catch (error) { return (error as Error).message; } })).toContain('只读');
  const before = await page.evaluate(() => window.chrona.observe().tick);
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await expect.poll(() => page.evaluate(() => window.chrona.observe().tick)).toBeGreaterThan(before + 10);
  await expect.poll(() => second.evaluate(() => window.chrona.observe().tick)).toBeGreaterThan(before + 10);
  await second.close();
});
test('paused observer movement cannot advance world state or queued physics', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await page.evaluate(() => window.chrona.runtime.pause(true));
  const before = await page.evaluate(() => window.chrona.observe());
  await page.locator('#enter-roam').click(); await page.keyboard.down('w');
  await expect.poll(() => page.evaluate(() => window.chrona.observe().camera.z)).toBeGreaterThan(before.camera.z + 1);
  await page.keyboard.up('w');
  expect(await page.evaluate(() => window.chrona.observe().tick)).toBe(before.tick);
  await page.keyboard.press('Escape');
});

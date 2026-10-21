import { expect, test, type Page } from '@playwright/test';
import { expectUnobscuredViews } from './view-layout';

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => window.chrona?.ready);
  await expect(page.locator('#loading')).toBeHidden();
}

test('four views render in a 2×2 grid; controls, observations and responsive layout work', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  const boxes = await page.locator('.view-panel').evaluateAll(panels => panels.map(panel => {
    const r = panel.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  expect(boxes).toHaveLength(4);
  expect(boxes[0].y).toBe(boxes[1].y); expect(boxes[2].y).toBe(boxes[3].y);
  expect(boxes[0].x).toBe(boxes[2].x); expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
  await expectUnobscuredViews(page);
  const panelFill = await page.locator('.view-grid').evaluate(grid => grid.getBoundingClientRect().bottom);
  expect(panelFill).toBeLessThanOrEqual(1000);
  expect(panelFill).toBeGreaterThan(980);
  await expect(page.locator('#loaded-stat')).toHaveText('加载 7');
  const capture = await page.evaluate(async () => window.chrona.capture());
  expect(capture.image).toMatch(/^data:image\/png;base64,/);
  expect(capture.image.length).toBeGreaterThan(10000);
  expect(capture.observation.viewport!.projectionMatrix).toHaveLength(16);
  expect(capture.observation.activeChunks).toHaveLength(7);
  const alignment = await page.evaluate(async () => {
    const r = window.chrona.runtime, original = { ...r.camera };
    await r.pause(true); await r.teleport(1400, 300);
    const frame = window.chrona.capture(), matrix = frame.observation.viewport!.cameraMatrix;
    const delta = [matrix[12] + frame.observation.origin.x - frame.observation.camera.x, matrix[13] - frame.observation.camera.y, matrix[14] + frame.observation.origin.z - frame.observation.camera.z];
    await r.teleport(original.x, original.z, original.y); await r.pause(false);
    return delta;
  });
  expect(alignment.every(value => Math.abs(value) < 1e-6)).toBe(true);
  await page.locator('#global-trail').uncheck();
  expect(await page.evaluate(async () => window.chrona.runtime.config.presentation.showGlobalTrail)).toBe(false);
  await page.locator('#map-trail').uncheck();
  expect(await page.evaluate(async () => window.chrona.runtime.config.presentation.showMapTrail)).toBe(false);
  await page.locator('#clock-pause').click();
  const tick = await page.evaluate(async () => window.chrona.observe().tick);
  await page.waitForTimeout(250);
  expect(await page.evaluate(async () => window.chrona.observe().tick)).toBe(tick);
  await page.locator('#clock-pause').click();
  await expect.poll(() => page.evaluate(async () => window.chrona.observe().tick)).toBeGreaterThan(tick);
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(async () => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.locator('#map-canvas').evaluate(canvas => {
    const c = canvas as HTMLCanvasElement;
    const pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] !== 238 || pixels[i + 1] !== 241 || pixels[i + 2] !== 232) painted++;
    return painted;
  })).toBeGreaterThan(100);
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  for (const width of [1024, 800, 640, 620, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expectUnobscuredViews(page);
  }
  expect(errors).toEqual([]);
});

test('pointer lock supports keyboard and mouse roaming; bridge traversal reaches the far bank', async ({ page }) => {
  await ready(page);
  const initial = await page.evaluate(async () => window.chrona.observe().camera);
  await page.locator('#enter-roam').click();
  await expect.poll(() => page.evaluate(async () => document.pointerLockElement?.id)).toBe('first-canvas');
  await page.keyboard.down('w');
  await expect.poll(() => page.evaluate(async () => window.chrona.observe().camera.z), { timeout: 15000 }).toBeGreaterThan(initial.z + 30);
  await page.keyboard.up('w');
  const before = await page.evaluate(async () => window.chrona.observe().camera.yaw);
  await page.mouse.move(30, 30);
  await expect.poll(() => page.evaluate(async () => window.chrona.observe().camera.yaw)).not.toBe(before);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(async () => document.pointerLockElement)).toBe(null);
  expect(await page.evaluate(async () => window.chrona.runtime.grounded)).toBe(true);
  expect(await page.evaluate(async () => window.chrona.snapshot().trail.length)).toBeGreaterThan(10);
});

test('streaming revisits preserve fingerprints; load range and persisted world recover after refresh', async ({ page }) => {
  await ready(page);
  const initial = await page.evaluate(async () => window.chrona.observe().activeChunks);
  await page.evaluate(async () => {
    await window.chrona.teleport(700, 320);
    await window.chrona.teleport(-500, -360);
    await window.chrona.teleport(0, 0);
  });
  expect(await page.evaluate(async () => window.chrona.observe().activeChunks)).toEqual(initial);
  expect(await page.evaluate(async () => window.chrona.runtime.chunks.records.size)).toBeGreaterThan(7);
  const originalConfig = await page.evaluate(async () => window.chrona.snapshot().config);
  await page.locator('#settings-toggle').click();
  await page.locator('[name=loadRange]').fill('3');
  await page.locator('[name=loadRange]').dispatchEvent('input');
  await page.locator('#settings-form button[type=submit]').click();
  await expect(page.locator('#settings')).toBeHidden();
  await expect(page.locator('#loaded-stat')).toHaveText('加载 19');
  const updatedConfig = await page.evaluate(async () => window.chrona.snapshot().config);
  expect(updatedConfig.population).toEqual(originalConfig.population);
  expect(updatedConfig.terrain).toEqual(originalConfig.terrain);
  await page.locator('#clock-pause').click();
  await page.evaluate(async () => window.chrona.save());
  const snapshot = await page.evaluate(async () => window.chrona.snapshot());
  const response = await page.request.get(`/api/worlds/${snapshot.id}`);
  expect(response.ok()).toBe(true);
  const saved = await response.json(); expect(saved.camera).toEqual(snapshot.camera);
  await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  const restored = await page.evaluate(async () => window.chrona.snapshot());
  expect(restored.id).toBe(snapshot.id); expect(restored.config).toEqual(snapshot.config);
  expect(restored.chunks.map(c => [c.q, c.r, c.fingerprint])).toEqual(snapshot.chunks.map(c => [c.q, c.r, c.fingerprint]));
  expect(Math.abs(restored.camera.x - snapshot.camera.x)).toBeLessThan(0.01);
  expect(Math.abs(restored.camera.z - snapshot.camera.z)).toBeLessThan(0.01);
  await page.locator('#load-world').click(); await expect(page.locator('#world-dialog')).toBeVisible();
  await expect(page.locator('.world-item').first()).toBeVisible();
});

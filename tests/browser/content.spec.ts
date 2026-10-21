import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('right-click instanced objects, converse, delete and undo while preserving identity on revisit/reload', async ({ page, request }) => {
  const recipe = JSON.parse(await readFile(new URL('.././fixtures/cherry.json', import.meta.url), 'utf8')); recipe.version = `1.0.${Date.now()}`;
  // Only the no-key authoring backend is mocked; source compilation, publishing and world edits are real.
  await page.route('**/api/content/edit', async route => {
    const body = route.request().postDataJSON();
    const base = { requestId: body.requestId, worldId: body.worldId, label: body.prompt, referenceIds: [], targetId: body.selection?.objectId, expectedVersion: body.selection?.version };
    if (body.prompt.includes('删除')) return route.fulfill({ json: { plan: { ...base, action: 'delete' }, trace: [], mode: 'api' } });
    const draft = await request.post('/api/content/validate', { data: { source: `export default defineContent(${JSON.stringify(recipe)});`, config: body.config } }); expect(draft.ok()).toBeTruthy();
    const release = await request.post('/api/content/publish', { data: { id: (await draft.json()).id } });
    return route.fulfill({ json: { plan: { ...base, action: body.prompt.includes('新增') ? 'create' : 'replace', point: body.selection?.point, asset: 'cherry', constraint: body.prompt }, release: await release.json(), trace: [], mode: 'api' } });
  });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await expect(page.locator('#scene-composer')).toBeHidden();
  await expect(page.locator('.composer-peek')).toHaveCount(0);
  await page.evaluate(async () => {
    const r = window.chrona.runtime; await r.pause(true);
    const a = [...r.chunks.assets.values()].find(a => a.kind === 'pine' && Math.hypot(a.x - r.camera.x, a.z - r.camera.z) > 10)!;
    await r.teleport(a.x, a.z + 5, a.y + r.config.population.treeHeight * a.scale * 0.7); await r.setCameraPose({ yaw: 0 }); await r.setCameraPose({ pitch: 0 });
  });
  await page.waitForTimeout(100);
  const before = await page.evaluate(async () => window.chrona.snapshot());
  const canvas = page.locator('#first-canvas'), rect = (await canvas.boundingBox())!;
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2, { button: 'right' });
  await expect(page.locator('#scene-composer')).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(page.locator('#composer-prompt')).toBeFocused(); await expect(page.locator('#composer-target')).toContainText('pine');
  const id = await page.evaluate(async () => window.chrona.editor.selection!.objectId!);
  expect(await page.evaluate(async () => {
    const value = window.chrona.editor.selection, selected = window.chrona.capture().image;
    window.chrona.editor.select(null); const plain = window.chrona.capture().image; window.chrona.editor.select(value);
    return selected === plain;
  })).toBe(true);
  await page.locator('#composer-prompt').fill('把它变成樱花树，有落英'); await page.locator('#composer-send').click();
  await expect(page.locator('#composer-messages')).toContainText('已应用编辑');
  await expect.poll(() => page.evaluate(async id => window.chrona.runtime.chunks.assets.get(id)?.design?.effect, id)).toBe('petals');
  await expect.poll(() => page.evaluate(async () => window.chrona.overview().cachedMeshes), { timeout: 15000 }).toBeGreaterThan(0);
  await page.locator('#composer-prompt').fill('删除它'); await page.locator('#composer-send').click();
  await expect.poll(() => page.evaluate(async id => window.chrona.runtime.chunks.assets.has(id), id)).toBe(false);
  await page.locator('#composer-undo').click();
  await expect.poll(() => page.evaluate(async id => window.chrona.runtime.chunks.assets.get(id)?.design?.effect, id)).toBe('petals');
  await page.locator('#composer-close').click();
  await page.evaluate(async () => { const p = { ...window.chrona.runtime.camera }; await window.chrona.teleport(1200, 800); await window.chrona.teleport(p.x, p.z, p.y); });
  await page.evaluate(async () => window.chrona.save()); await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  const after = await page.evaluate(async id => ({ snapshot: window.chrona.snapshot(), effect: window.chrona.runtime.chunks.assets.get(id)?.design?.effect }), id);
  expect(after.effect).toBe('petals'); expect(after.snapshot.tick).toBe(before.tick);
  for (const c of before.chunks) expect(after.snapshot.chunks.find(p => p.q === c.q && p.r === c.r)?.fingerprint).toBe(c.fingerprint);
  await page.evaluate(async () => {
    const r = window.chrona.runtime;
    for (const c of r.chunks.active.values()) for (let x = c.center.x - 15; x < c.center.x + 15; x += 4) for (let z = c.center.z - 15; z < c.center.z + 15; z += 4) {
      const y = r.groundHeight(x, z);
      if (y <= r.config.terrain.waterLevel + 1 || [...r.chunks.assets.values()].some(a => Math.hypot(a.x - x, a.z - z) < 8)) continue;
      await r.teleport(x, z + 6, y + 3); await r.setCameraPose({ yaw: 0 }); await r.setCameraPose({ pitch: 0 });
      window.chrona.editor.select(null); return;
    }
    throw new Error('No clear creation anchor');
  });
  const additions = await page.evaluate(async () => Object.keys(window.chrona.runtime.content.state.additions).length);
  await page.locator('#composer-toggle').click(); await page.locator('#composer-prompt').fill('在前方新增一棵樱花树'); await page.locator('#composer-send').click();
  await expect.poll(() => page.evaluate(async () => Object.keys(window.chrona.runtime.content.state.additions).length)).toBe(additions + 1);
  await page.locator('#composer-close').click();
  await page.locator('#composer-toggle').click(); await page.locator('#composer-prompt').fill('wasd R 空格输入');
  const p = await page.evaluate(async () => ({ ...window.chrona.runtime.camera })); await page.keyboard.press('Space');
  expect((await page.evaluate(async () => window.chrona.runtime.camera)).x).toBe(p.x);
  await page.locator('#composer-resume').click();
  await page.waitForFunction(() => document.pointerLockElement?.id === 'first-canvas');
  await page.evaluate(async () => {
    const r = window.chrona.runtime, a = [...r.chunks.assets.values()].find(a => a.kind === 'pine' && !a.design)!;
    await r.teleport(a.x, a.z + 5, a.y + r.config.population.treeHeight * a.scale * 0.7); await r.setCameraPose({ yaw: 0 }); await r.setCameraPose({ pitch: 0 });
  });
  await page.waitForTimeout(80);
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
  await expect(page.locator('#scene-composer')).toBeHidden();
  await page.waitForFunction(() => document.pointerLockElement?.id === 'first-canvas');
  expect(await page.evaluate(async () => window.chrona.editor.selection?.kind)).toBe('object');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.pointerLockElement);
  await expect(page.locator('#composer-prompt')).toBeFocused();
  await page.keyboard.type('可以直接输入 wasd R');
  await expect(page.locator('#composer-prompt')).toHaveValue('wasd R 空格输入 可以直接输入 wasd R');
  // No accidental re-lock from clicking the scene while editing.
  await page.mouse.click(rect.x + 15, rect.y + 15);
  expect(await page.evaluate(async () => document.pointerLockElement)).toBe(null);
  await expect(page.locator('#composer-prompt')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#scene-composer')).toBeHidden();
  await page.waitForFunction(() => document.pointerLockElement?.id === 'first-canvas');
  const yaw = await page.evaluate(async () => window.chrona.runtime.camera.yaw);
  await page.mouse.move(35, 45);
  await expect.poll(() => page.evaluate(async () => window.chrona.runtime.camera.yaw)).not.toBe(yaw);
  await page.evaluate(async () => { await window.chrona.runtime.pause(false); });
  const position = await page.evaluate(async () => ({ ...window.chrona.runtime.camera }));
  await page.keyboard.down('w');
  await expect.poll(() => page.evaluate(async p => Math.hypot(window.chrona.runtime.camera.x - p.x, window.chrona.runtime.camera.z - p.z), position)).toBeGreaterThan(0.1);
  await page.keyboard.press('Enter'); await expect(page.locator('#composer-prompt')).toBeFocused();
  await page.keyboard.up('w');
  const editing = await page.evaluate(async () => ({ ...window.chrona.runtime.camera }));
  await page.waitForTimeout(100);
  expect(await page.evaluate(async p => Math.hypot(window.chrona.runtime.camera.x - p.x, window.chrona.runtime.camera.z - p.z), editing)).toBeLessThan(0.01);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(async () => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

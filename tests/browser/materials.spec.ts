import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('chat applies and refines bound proxy materials, records video context, restores saved surfaces and undoes the edit', async ({ page, request }) => {
  const raw = JSON.parse(await readFile(new URL('../fixtures/material-station.json', import.meta.url), 'utf8'));
  let calls = 0;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/content/edit', async route => {
    const body = route.request().postDataJSON(), pack = structuredClone(raw); calls++;
    pack.version = `1.${Date.now()}.${calls}`;
    if (calls > 1) {
      expect(body.target.asset.design.materials['wood-post'].texture.seed).toBe(17);
      pack.assets.station.materials['wood-post'].color = '#ac764a';
      pack.assets.station.materials.copper.roughness = 0.5;
    }
    const source = `export default defineContent(${JSON.stringify(pack)});`;
    const draft = await request.post('/api/content/validate', { data: { source, config: body.config } }); expect(draft.ok()).toBeTruthy();
    const report = (await draft.json());
    expect(report.report.materials[0].bindings.find((m: { id: string }) => m.id === 'wood-post').partIndices).toEqual([1, 2]);
    const release = await request.post('/api/content/publish', { data: { id: report.id } }); expect(release.ok()).toBeTruthy();
    await route.fulfill({ json: { mode: 'api', trace: [], release: await release.json(), plan: {
      requestId: body.requestId, worldId: body.worldId, action: calls === 1 ? 'create' : 'replace', label: '材质编辑', asset: 'station',
      ...(calls === 1 ? { point: body.selection.point } : { targetId: body.selection.objectId, expectedVersion: body.selection.version }),
      constraint: '暖灰色石台、木纹支架、铜球和淡蓝色玻璃灯', referenceIds: [] } } });
  });
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await page.evaluate(async () => {
    const r = window.chrona.runtime; await r.pause(true);
    for (const c of r.chunks.active.values()) for (let x = c.center.x - 15; x < c.center.x + 15; x += 4) for (let z = c.center.z - 15; z < c.center.z + 15; z += 4) {
      const y = r.groundHeight(x, z);
      if (y <= r.config.terrain.waterLevel + 1 || [...r.chunks.assets.values()].some(a => Math.hypot(a.x - x, a.z - z) < 8)) continue;
      await r.teleport(x, z + 6, y + 2.5); await r.setCameraPose({ yaw: 0 }); await r.setCameraPose({ pitch: -0.15 });
      window.chrona.editor.select({ kind: 'ground', label: '空地', point: { x, y, z } }); return;
    }
    throw new Error('No clear anchor');
  });
  const old = await page.evaluate(async () => window.chrona.snapshot().chunks);
  await page.locator('#composer-toggle').click(); await page.locator('#composer-prompt').fill('在这里新增带木纹支架、铜球、半透明玻璃和石座的观察台'); await page.locator('#composer-send').click();
  await expect(page.locator('#composer-messages')).toContainText('已应用编辑');
  const created = await page.evaluate(async () => [...window.chrona.runtime.sceneAssets.values()].find(a => a.design?.label === '材质观察台'));
  expect(created).toBeTruthy();
  await page.locator('#composer-prompt').fill('保持造型和碰撞不变，把木头改成浅棕色，铜表面改成微磨损'); await page.locator('#composer-send').click();
  await expect.poll(() => page.evaluate(async id => window.chrona.runtime.editor.object(id)?.design?.materials?.['wood-post'].color, created!.id)).toBe('#ac764a');
  const updated = await page.evaluate(async id => ({ object: window.chrona.runtime.editor.object(id), context: window.chrona.content.inspect().objects.find(o => o.id === id) }), created!.id);
  expect(updated.object?.design?.parts).toEqual(created!.design!.parts); expect(updated.object?.design?.collider).toEqual(created!.design!.collider);
  expect(updated.context?.appearance?.materials?.find(m => m.id === 'wood-post')?.texture?.seed).toBe(17);
  expect(updated.context?.appearance?.materials?.find(m => m.id === 'copper')?.metalness).toBe(0.8);
  await page.keyboard.press('Escape'); await page.waitForTimeout(900);
  await page.locator('#first-canvas').screenshot({ path: test.info().outputPath('materials-proxy.png') });
  await page.evaluate(async () => window.chrona.save()); await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  expect(await page.evaluate(async id => window.chrona.runtime.editor.object(id)?.design?.materials?.['wood-post'].color, created!.id)).toBe('#ac764a');
  await page.locator('#composer-toggle').click(); await page.locator('#composer-undo').click();
  await expect.poll(() => page.evaluate(async id => window.chrona.runtime.editor.object(id)?.design?.materials?.['wood-post'].color, created!.id)).toBe('#83532e');
  for (const c of old) expect((await page.evaluate(async () => window.chrona.snapshot().chunks)).find(p => p.q === c.q && p.r === c.r)?.fingerprint).toBe(c.fingerprint);
  expect(errors).toEqual([]);
});

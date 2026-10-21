import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { compilePlugin, validatePackage } from '../apps/api/src/content-registry';
import { contentPackageSchema, type EditPlan } from '../packages/protocol/src/content';
import { resolvePartMaterial, assetAppearance } from '../packages/protocol/src/materials';
import { createAssetVisual } from '../packages/viewer/src/assets';
import { surfacePixels } from '../packages/viewer/src/materials';
import { disposeGroup } from '../packages/viewer/src/chunk-visual';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { WorldRuntime, initializePhysics } from '../packages/adapters/src/rapier/runtime';
import { snapshotSchema } from '../packages/protocol/src/contracts';

const fixture = async () => JSON.parse(await readFile(new URL('./fixtures/material-station.json', import.meta.url), 'utf8'));
test('named PBR surfaces compile, bind and reject unsupported or ambiguous materials', async () => {
  const raw = await fixture(), pack = compilePlugin(`export default defineContent(${JSON.stringify(raw)});`);
  const report = validatePackage(pack), binding = report.materials[0];
  assert.deepEqual(binding.unused, []); assert.deepEqual(binding.bindings.find(m => m.id === 'wood-post')?.partIndices, [1, 2]);
  for (const change of [
    (v: any) => { v.assets.station.parts[1].material = 'missing'; },
    (v: any) => { v.assets.station.parts[1].color = '#ffffff'; },
    (v: any) => { v.assets.station.materials.copper.metalness = 1.1; },
    (v: any) => { v.assets.station.materials.glass.opacity = 0; },
    (v: any) => { v.assets.station.materials.copper.map = 'https://untrusted.example/image.png'; },
    (v: any) => { v.assets.station.materials['wood-post'].texture.repeat = [99, 2]; },
    (v: any) => { delete v.assets.station.materials.lamp.emissive; },
  ]) { const invalid = structuredClone(raw); change(invalid); assert.throws(() => compilePlugin(`export default defineContent(${JSON.stringify(invalid)});`)); }
  const old = JSON.parse(await readFile(new URL('./fixtures/cherry.json', import.meta.url), 'utf8'));
  const inline = structuredClone(old);
  inline.assets.cherry.parts[0] = { shape: 'box', size: [1,1,1], position: [0,0,0], color: '#ffffff', roughness: 0.9 };
  assert.throws(() => contentPackageSchema.parse(inline));
  assert.throws(() => contentPackageSchema.parse({ ...old, terrain: { amplitude: 1, wavelength: 100, tint: '#ffffff' } }));
});

test('renderer resolves real PBR parameters, repeatable textures, shared bindings and texture disposal', async () => {
  const design = contentPackageSchema.parse(await fixture()).assets.station;
  const visual = createAssetVisual({ id: 'test', kind: 'custom', x: 0, y: 0, z: 0, scale: 1, rotation: 0, variant: 0, design }, DEFAULT_CONFIG);
  const children = visual.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[];
  assert.equal(children[1].material, children[2].material);
  assert.equal(children[3].material.metalness, 0.8); assert.equal(children[4].material.opacity, 0.45);
  assert.equal(children[4].material.transparent, true); assert.equal(children[4].castShadow, false);
  assert.equal(children[5].material.emissiveIntensity, 1.5);
  const spec = resolvePartMaterial(design, design.parts[1]);
  assert.deepEqual(children[1].material.map?.repeat.toArray(), [2, 3]); assert.equal(children[1].material.bumpScale, 0.025);
  const pixels = surfacePixels(spec.texture!);
  assert.deepEqual(surfacePixels(spec.texture!), pixels);
  assert.notDeepEqual(surfacePixels({ ...spec.texture!, seed: 18 }), pixels);
  assert.ok(new Set(pixels).size > 20);
  let disposed = 0; children[1].material.map!.addEventListener('dispose', () => disposed++);
  disposeGroup(visual); assert.equal(disposed, 1);
});

test('material replacement persists across streaming and save, updates context and undo restores previous surfaces and collision data', async () => {
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG)); world.clock.paused = true;
  try {
    const pack = contentPackageSchema.parse(await fixture()), camera = { ...world.camera }, old = world.snapshot().chunks;
    const tree = [...world.chunks.assets.values()].find(a => a.kind === 'pine' && Math.hypot(a.x - camera.x, a.z - camera.z) > 8)!;
    const plan = (asset: string): EditPlan => ({ requestId: crypto.randomUUID(), worldId: world.id, label: '材质编辑', action: 'replace',
      targetId: tree.id, expectedVersion: world.editor.version(tree.id), asset, referenceIds: [], constraint: '暖灰石台、木纹支柱、铜球和蓝色玻璃' });
    // Existing placement validation remains in use; this small footprint fits the source tree.
    world.editor.apply(plan('station'), pack);
    const prior = structuredClone(world.editor.object(tree.id)!), update = structuredClone(pack); update.version = '1.0.1';
    update.assets.station.materials!['wood-post'].color = '#a96a43'; update.assets.station.materials!.copper.roughness = 0.5;
    world.editor.apply(plan('station'), update);
    const current = world.editor.object(tree.id)!;
    assert.deepEqual(current.design!.parts, prior.design!.parts); assert.deepEqual(current.design!.collider, prior.design!.collider);
    assert.equal(current.x, prior.x); assert.equal(current.rotation, prior.rotation);
    assert.equal(assetAppearance(current.design)?.materials?.find(m => m.id === 'wood-post')?.color, '#a96a43');
    world.teleport(1400, 900); world.teleport(camera.x, camera.z, camera.y);
    assert.equal(world.editor.object(tree.id)?.design?.materials?.['wood-post'].texture?.seed, 17);
    const saved = snapshotSchema.parse(world.snapshot(true)), restored = new WorldRuntime(saved.config, saved);
    try {
      assert.equal(restored.editor.object(tree.id)?.design?.materials?.['wood-post'].color, '#a96a43');
      restored.editor.undo(); assert.deepEqual(restored.editor.object(tree.id)?.design, prior.design);
      assert.equal(restored.clock.tick, saved.tick);
    } finally { restored.dispose(); }
    for (const c of old) assert.equal(world.chunks.records.get(`${c.q},${c.r}`)?.fingerprint, c.fingerprint);
  } finally { world.dispose(); }
});

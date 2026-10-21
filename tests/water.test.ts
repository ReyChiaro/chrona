import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waterFixture } from './fixtures/water-scene';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { contentPackageSchema, type ContentPackage } from '../packages/protocol/src/content';
import { WorldContent } from '../packages/world/src/content';
import { evaluateRegion } from '../packages/world/src/region-validation';
import { validatePackage } from '../apps/api/src/content-registry';
import { regionCells } from '../packages/world/src/regions';
import { clipWaterTriangle, polygonArea } from '../packages/world/src/water';
import { createChunkVisual, disposeGroup } from '../packages/viewer/src/chunk-visual';
import { WorldRuntime, initializePhysics } from '../packages/adapters/src/rapier/runtime';
import { snapshotSchema } from '../packages/protocol/src/contracts';
import { hexKey } from '../packages/world/src/hex';
import { requestsWater } from '../packages/world/src/water-validation';
import { columnBottom } from '../packages/world/src/surface';
import * as THREE from 'three';

const evaluate = (pack: ContentPackage, prompt = '海洋、沙滩和海带水草') => { const content = new WorldContent(); content.deployRegion(pack, [], 0); return { content, report: evaluateRegion(content, pack, DEFAULT_CONFIG, prompt) }; };

test('native sea clips to actual terrain at one absolute level and has a connected coast and submerged vegetation', () => {
  const pack = waterFixture(), { content, report } = evaluate(pack);
  assert.equal(report.status, 'passed', JSON.stringify(report));
  assert.ok(report.water!.area > 10000 && report.water!.maxDepth > 10 && report.water!.shoreline > 200 && report.water!.beachArea > 100);
  assert.equal(report.water!.components, 1); assert.ok(report.water!.largestComponentRatio > 0.99 && report.water!.submergedPlants >= 8);
  const signatures = new Map<string, Set<string>>(); let waterChunks = 0;
  for (const cell of regionCells(pack.region!, DEFAULT_CONFIG)) {
    const chunk = content.generate(cell, DEFAULT_CONFIG), visual = createChunkVisual(chunk, DEFAULT_CONFIG, 0);
    const water = visual.group.children.find(child => child.userData.pickRole === 'water') as THREE.Mesh;
    const positions = water.geometry.getAttribute('position');
    const lowest = Math.min(...Array.from(chunk.positions).filter((_, i) => i % 3 === 1));
    assert.ok(columnBottom(chunk, DEFAULT_CONFIG.terrain.columnDepth) < lowest, 'column walls must stay below the seabed');
    if (positions.count) waterChunks++;
    const points = new Set<string>();
    for (let i = 0; i < positions.count; i++) {
      assert.ok(Math.abs(positions.getY(i) - (DEFAULT_CONFIG.terrain.waterLevel + 0.025)) < 1e-6);
      points.add(`${Math.round((positions.getX(i) + chunk.center.x) * 1000)},${Math.round((positions.getZ(i) + chunk.center.z) * 1000)}`);
    }
    signatures.set(chunk.key, points); disposeGroup(visual.group);
  }
  assert.ok(waterChunks > 7);
  let matched = 0;
  for (const [key, points] of signatures) for (const [other, otherPoints] of signatures) if (key < other && [...points].some(p => otherPoints.has(p))) matched++;
  assert.ok(matched > 6, 'native wet vertices must meet across chunk boundaries');
  const triangle = [{ x: 0, y: -2, z: 0 }, { x: 10, y: 2, z: 0 }, { x: 0, y: 2, z: 10 }], polygon = clipWaterTriangle(triangle, 0);
  assert.equal(polygonArea(polygon), 12.5); assert.ok(polygon.every(p => p.y === 0));
});

test('fake water tiles, dry basins and disconnected puddles fail actual water acceptance', () => {
  const pack = waterFixture();
  const absent = structuredClone(pack); delete absent.region!.water;
  assert.throws(() => validatePackage(absent, DEFAULT_CONFIG, { prompt: '前方生成海洋' }), /region.water/);
  const dry = structuredClone(pack); dry.region!.elevation = 30; dry.region!.operators = [];
  const noWater = evaluate(dry); assert.equal(noWater.report.status, 'failed'); assert.equal(noWater.report.water!.area, 0);
  const fake = structuredClone(pack);
  fake.assets['sea-water'] = contentPackageSchema.parse({ protocol: 1, id: 'fake', version: '1.0.0', title: 'fake', description: '', assets: { tile: {
    label: '海水面片', materials: { water: { label: '海水', color: '#2b7d97', roughness: 0.16, opacity: 0.55 } },
    parts: [{ shape: 'box', size: [32, 0.4, 32], position: [0, 5.2, 0], material: 'water' }], collider: null } } }).assets.tile;
  assert.ok(evaluate(fake).report.failures.some(f => f.includes('separate water tile')));
  const islands = structuredClone(pack); islands.region!.operators = [-40, 40].map(x => ({ kind: 'terrace', height: -30, radius: 40, offset: { x, z: 0 } }));
  const disconnected = evaluate(islands);
  assert.equal(disconnected.report.metrics.find(m => m.criterion === 'minConnectedWaterRatio')?.passed, false);
  assert.equal(requestsWater('把灯罩改成海洋蓝色'), false);
  assert.equal(requestsWater('生成海洋，水是海洋蓝色'), true);
});

test('water region save and revisit keep fingerprints and a paused world; old chunks remain unchanged', async () => {
  await initializePhysics(); const runtime = new WorldRuntime(structuredClone(DEFAULT_CONFIG)); runtime.clock.paused = true;
  try {
    const old = runtime.snapshot(), pack = waterFixture();
    runtime.editor.apply({ requestId: crypto.randomUUID(), worldId: runtime.id, action: 'future', label: '原生海洋', referenceIds: [], intent: '海洋和海带' }, pack);
    const center = pack.region!.center; runtime.teleport(center.x, center.z);
    assert.ok([...runtime.chunks.active.values()].some(c => c.biome === 'ocean'));
    const rapier = (await import('@dimforge/rapier3d-compat')).default;
    const ray = new rapier.Ray({ x: center.x - runtime.origin.x, y: 100, z: center.z - runtime.origin.z }, { x: 0, y: -1, z: 0 });
    let nearest = Infinity;
    runtime.physics.colliders.forEach(c => { if (c.shapeType() === rapier.ShapeType.TriMesh) { const hit = c.castRay(ray, 300, true); if (hit >= 0) nearest = Math.min(nearest, hit); } });
    assert.ok(Number.isFinite(nearest));
    assert.ok(Math.abs(100 - nearest - runtime.groundHeight(center.x, center.z)) < 0.001, 'Rapier collision must follow seabed, not a fake water tile');
    const records = [...runtime.chunks.records.values()]; runtime.teleport(old.camera.x, old.camera.z, old.camera.y);
    for (const c of old.chunks) assert.equal(runtime.chunks.records.get(hexKey(c))?.fingerprint, c.fingerprint);
    const saved = snapshotSchema.parse(runtime.snapshot(true)), restored = new WorldRuntime(saved.config, saved);
    try { restored.teleport(center.x, center.z); for (const c of records) assert.equal(restored.chunks.records.get(hexKey(c))?.fingerprint, c.fingerprint); assert.equal(restored.clock.tick, old.tick); }
    finally { restored.dispose(); }
    // Neighboring terrain surfaces share authoritative boundary samples as well as water vertices.
    const content = new WorldContent(runtime.content.state), a = content.generate({ q: 0, r: -10 }, DEFAULT_CONFIG), b = content.generate({ q: 1, r: -10 }, DEFAULT_CONFIG);
    const border = a.boundary.map(p => ({ x: a.center.x + p.x, z: a.center.z + p.z, y: p.y }));
    for (const p of b.boundary) { const common = border.find(v => Math.hypot(v.x - b.center.x - p.x, v.z - b.center.z - p.z) < 1e-4); if (common) assert.ok(Math.abs(common.y - p.y) < 1e-4); }
  } finally { runtime.dispose(); }
});

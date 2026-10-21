import { test } from 'node:test';
import assert from 'node:assert/strict';
import { regionalFixture } from './fixtures/regional-scenes';
import { compilePlugin, validatePackage } from '../apps/api/src/content-registry';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { WorldContent } from '../packages/world/src/content';
import { evaluateRegion } from '../packages/world/src/region-validation';
import { WorldRuntime, initializePhysics } from '../packages/adapters/src/rapier/runtime';
import { vehiclePose } from '../packages/adapters/src/rapier/traffic';
import { snapshotSchema } from '../packages/protocol/src/contracts';
import { surfaceHeight } from '../packages/world/src/surface';
import { worldToHex, hexKey } from '../packages/world/src/hex';

for (const kind of ['snow', 'volcano', 'city'] as const) test(`${kind}: real generated geometry and requested criteria are checked`, () => {
  const pack = regionalFixture(kind), source = `export default defineContent(${JSON.stringify(pack)});`;
  const compiled = compilePlugin(source), result = validatePackage(compiled);
  assert.equal(result.passed, true); assert.equal(result.completion!.status, 'passed');
  assert.ok(result.completion!.metrics.every(m => m.passed));
});

test('empty city, tint-only volcano, static cars and unsafe placements cannot report completion', () => {
  const city = regionalFixture('city'); city.region!.placements = [];
  assert.throws(() => validatePackage(city, DEFAULT_CONFIG, { prompt: '城市和行驶的汽车' }), /minBuildings/);
  const volcano = regionalFixture('volcano'); volcano.region!.operators = [];
  assert.throws(() => validatePackage(volcano, DEFAULT_CONFIG, { prompt: '火山地形' }), /minCraterDepth/);
  const staticCity = regionalFixture('city'); staticCity.region!.vehicles = [];
  assert.throws(() => validatePackage(staticCity, DEFAULT_CONFIG, { prompt: '行驶的汽车' }), /minMovingVehicles/);
  const overlap = regionalFixture('city'); overlap.region!.placements[0].position = { x: 0, z: 0 };
  assert.throws(() => validatePackage(overlap), /occupies road/);
});

test('protected old cell remains identical and new-neighbor boundary follows its original surface', () => {
  const content = new WorldContent(), pack = regionalFixture('snow', { x: 0, z: 0 });
  const old = content.generate({ q: 0, r: 0 }, DEFAULT_CONFIG);
  content.deployRegion(pack, ['0,0'], 0);
  const restored = content.generate({ q: 0, r: 0 }, DEFAULT_CONFIG, { q: 0, r: 0, fingerprint: old.fingerprint, firstTick: 0, visits: 1 });
  assert.equal(restored.fingerprint, old.fingerprint); assert.deepEqual(restored.positions, old.positions);
  const neighbor = content.generate({ q: 1, r: 0 }, DEFAULT_CONFIG);
  for (const p of old.boundary) {
    const x = old.center.x + p.x, z = old.center.z + p.z;
    const h = surfaceHeight(neighbor, x, z);
    if (h !== undefined) assert.ok(Math.abs(h - p.y) < 1e-3, `seam ${h} vs ${p.y}`);
  }
});

test('city runtime moves collidable vehicles, freezes on pause, restores world-time phase and preserves old chunks', async () => {
  await initializePhysics();
  const config = structuredClone(DEFAULT_CONFIG); config.clock.timeScale = 1; config.loadRange = 4;
  const world = new WorldRuntime(config), before = world.snapshot(), city = regionalFixture('city');
  try {
    const report = world.editor.apply({ requestId: crypto.randomUUID(), worldId: world.id, action: 'future', label: '城市', referenceIds: [], intent: '城市有摩天大楼和行驶的汽车' }, city).regionReport!;
    assert.equal(report.status, 'passed');
    assert.deepEqual(world.snapshot().chunks, before.chunks);
    world.teleport(city.region!.center.x, city.region!.center.z);
    assert.equal(world.traffic.assets.size, 2); assert.equal(world.traffic.bodies.size, 2);
    const id = [...world.traffic.assets.keys()][0], p = { ...world.traffic.assets.get(id)! };
    const input = { forward: 0, right: 0, sprint: false, jump: false };
    for (let i = 0; i < 120; i++) world.update(1 / 60, input);
    assert.ok(Math.hypot(world.traffic.assets.get(id)!.x - p.x, world.traffic.assets.get(id)!.z - p.z) > 5);
    world.clock.paused = true; const frozen = { ...world.traffic.assets.get(id)! }; world.update(1, input);
    assert.equal(world.traffic.assets.get(id)!.x, frozen.x); assert.equal(world.traffic.assets.get(id)!.z, frozen.z);
    world.clock.paused = false; world.teleport(1000, 1000); assert.equal(world.traffic.bodies.size, 0);
    for (let i = 0; i < 120; i++) world.update(1 / 60, input);
    world.teleport(city.region!.center.x, city.region!.center.z);
    const expected = vehiclePose(city, city.region!.vehicles[0], world.clock.elapsedSeconds), actual = world.traffic.assets.get(expected.id)!;
    assert.ok(Math.hypot(expected.x - actual.x, expected.z - actual.z) < 1e-5);
    for (const c of before.chunks) assert.equal(world.chunks.records.get(`${c.q},${c.r}`)!.fingerprint, c.fingerprint);
    const saved = snapshotSchema.parse(world.snapshot(true)), restored = new WorldRuntime(saved.config, saved);
    try { assert.ok(Math.hypot(restored.traffic.assets.get(id)!.x - actual.x, restored.traffic.assets.get(id)!.z - actual.z) < 1e-5); } finally { restored.dispose(); }
  } finally { world.dispose(); }
});

test('overlapping deployments replace core terrain rather than adding height, and keep earlier explored cells pinned', () => {
  const content = new WorldContent(), snow = regionalFixture('snow'), city = regionalFixture('city');
  content.deployRegion(snow, [], 0);
  const oldCell = worldToHex(-110, -500, DEFAULT_CONFIG.chunkRadius), old = content.generate(oldCell, DEFAULT_CONFIG);
  content.deployRegion(city, [hexKey(oldCell)], 1);
  const original = content.generate(oldCell, DEFAULT_CONFIG, { ...oldCell, fingerprint: old.fingerprint, firstTick: 0, visits: 1, contentPackages: old.contentPackages });
  assert.equal(original.fingerprint, old.fingerprint);
  const cell = worldToHex(0, -500, DEFAULT_CONFIG.chunkRadius), chunk = content.generate(cell, DEFAULT_CONFIG);
  assert.ok(Math.abs(surfaceHeight(chunk, 0, -500)! - city.region!.elevation) < 1e-4);
});

test('regional mountains preserve requested original road corridors', () => {
  const config = structuredClone(DEFAULT_CONFIG); config.seed = 'regional-acceptance';
  const content = new WorldContent(), pack = regionalFixture('snow', { x: 0, z: 306 }); pack.region!.preserveCorridors = true;
  const cell = worldToHex(0, 306, config.chunkRadius), base = content.generate(cell, config);
  content.deployRegion(pack, [], 0);
  const changed = content.generate(cell, config);
  assert.ok(Math.abs(surfaceHeight(changed, 0, 306)! - surfaceHeight(base, 0, 306)!) < 0.15);
});


test('moving vehicle deletion and constraint edits undo at the current world-time pose', async () => {
  await initializePhysics();
  const config = structuredClone(DEFAULT_CONFIG); config.loadRange = 4; config.clock.timeScale = 1;
  const world = new WorldRuntime(config), city = regionalFixture('city');
  try {
    world.editor.apply({ requestId: crypto.randomUUID(), worldId: world.id, action: 'future', label: '城市', referenceIds: [] }, city);
    world.teleport(0, -500);
    const id = [...world.traffic.assets.keys()][0];
    world.editor.apply({ requestId: crypto.randomUUID(), worldId: world.id, action: 'constraint', targetId: id, expectedVersion: world.editor.version(id), label: '车体约束', constraint: '保持红色', referenceIds: [] });
    world.editor.undo();
    assert.ok(world.traffic.assets.has(id)); assert.ok(!world.content.state.constraints.some(c => c.objectId === id));
    world.editor.apply({ requestId: crypto.randomUUID(), worldId: world.id, action: 'delete', targetId: id, expectedVersion: world.editor.version(id), label: '删除车辆', referenceIds: [] });
    assert.ok(!world.traffic.bodies.has(id));
    for (let i = 0; i < 120; i++) world.update(1 / 60, { forward: 0, right: 0, sprint: false, jump: false });
    const expected = world.traffic.resolve(id, world.clock.elapsedSeconds)!;
    world.editor.undo();
    const restored = world.traffic.assets.get(id)!;
    assert.ok(Math.hypot(restored.x - expected.x, restored.z - expected.z) < 1e-5);
  } finally { world.dispose(); }
});

test('distant overview LOD retains the city skyline without changing authoritative geometry', async () => {
  const { buildOverviewMesh } = await import('../packages/viewer/src/overview-data');
  const content = new WorldContent(), pack = regionalFixture('city'); content.deployRegion(pack, [], 0);
  const cell = worldToHex(25, -475, DEFAULT_CONFIG.chunkRadius), chunk = content.generate(cell, DEFAULT_CONFIG);
  const original = chunk.fingerprint;
  const surface = buildOverviewMesh(cell, DEFAULT_CONFIG, 'surface', chunk), detail = buildOverviewMesh(cell, DEFAULT_CONFIG, 'detail', chunk);
  const top = [...surface.positions].filter((_, i) => i % 3 === 1).reduce((a, b) => Math.max(a, b), -Infinity);
  assert.ok(top >= pack.region!.elevation + 30);
  assert.ok(surface.positions.length < detail.positions.length);
  assert.equal(chunk.fingerprint, original);
});

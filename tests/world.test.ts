import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, configSchema } from '../packages/protocol/src/config';
import { snapshotSchema } from '../packages/protocol/src/contracts';
import { hexCenter, hexDisk, hexDistance, hexNeighbors, worldToHex } from '../packages/world/src/hex';
import { boundarySamples, generateChunk } from '../packages/world/src/generator';
import { ChunkManager } from '../packages/world/src/chunks';
import { WorldClock } from '../packages/world/src/clock';
import { initializePhysics, WorldRuntime, type MovementInput } from '../packages/adapters/src/rapier/runtime';
import { riverCenter, terrainHeight } from '../packages/world/src/terrain';
import { IntegrationRegistry } from '../apps/web/src/integrations/providers';
import { biomeAt } from '../packages/world/src/terrain';
import { villagePlan } from '../packages/world/src/settlements';

const idle: MovementInput = { forward: 0, right: 0, sprint: false, jump: false };
const advance = (world: WorldRuntime, seconds: number, input = idle) => {
  for (let i = 0; i < seconds * world.config.physics.frequency; i++) world.update(1 / world.config.physics.frequency, input);
};

test('regional PCG creates mountains, meadows and varied seeded villages beyond the initial area', () => {
  const biomes = new Set<string>(); let lowest = Infinity, highest = -Infinity;
  for (let x = -500; x <= 500; x += 20) for (let z = -500; z <= 500; z += 20) {
    const height = terrainHeight(x, z, DEFAULT_CONFIG);
    lowest = Math.min(lowest, height); highest = Math.max(highest, height);
    biomes.add(biomeAt(x, z, DEFAULT_CONFIG));
  }
  assert.ok(highest - lowest > 50);
  for (const biome of ['mountain', 'highland', 'meadow', 'forest', 'river', 'village']) assert.ok(biomes.has(biome), biome);
  const plans = Array.from({ length: 25 }, (_, i) => villagePlan(i % 5 - 2, Math.floor(i / 5) - 2, DEFAULT_CONFIG));
  assert.ok(plans.some(plan => !plan.present));
  assert.ok(new Set(plans.filter(plan => plan.present).map(plan => plan.houses.length)).size > 2);
  assert.ok(plans.some(plan => Math.abs(plan.x / DEFAULT_CONFIG.population.villageSpacing - plan.region.x) > 0.05));
  for (const plan of plans) assert.deepEqual(villagePlan(plan.region.x, plan.region.z, structuredClone(DEFAULT_CONFIG)), plan);
  assert.notDeepEqual(villagePlan(1, 1, { ...DEFAULT_CONFIG, seed: 'different-villages' }), villagePlan(1, 1, DEFAULT_CONFIG));
});

test('axial coordinates round-trip at negative and distant positions; loading disks have exact bounds', () => {
  for (const q of [-100000, -8, -1, 0, 1, 18, 100000]) for (const r of [-120000, -3, 0, 7, 90000]) {
    const p = hexCenter({ q, r }, DEFAULT_CONFIG.chunkRadius);
    assert.deepEqual(worldToHex(p.x, p.z, DEFAULT_CONFIG.chunkRadius), { q, r });
  }
  for (let range = 1; range <= 6; range++) {
    const center = { q: -3, r: 8 }, cells = hexDisk(center, range);
    assert.equal(cells.length, 1 + 3 * (range - 1) * range);
    assert.ok(cells.every(cell => hexDistance(cell, center) < range));
  }
});

test('every adjacent hex shares the same boundary positions and terrain elevations', () => {
  for (const cell of [{ q: 0, r: 0 }, { q: -9, r: 12 }, { q: 10000, r: -11000 }]) {
    const original = boundarySamples(cell, DEFAULT_CONFIG);
    for (const neighbor of hexNeighbors(cell)) {
      const other = boundarySamples(neighbor, DEFAULT_CONFIG);
      const shared = original.filter(p => other.some(o => Math.hypot(p.x - o.x, p.z - o.z) < 0.00001));
      assert.equal(shared.length, DEFAULT_CONFIG.subdivisions + 1);
      for (const point of shared) {
        const match = other.find(o => Math.hypot(point.x - o.x, point.z - o.z) < 0.00001)!;
        assert.ok(Math.abs(point.y - match.y) < 0.00001);
      }
    }
  }
});

test('generation is order-independent, and cross-chunk assets use identical identities and transforms', () => {
  const cells = hexDisk({ q: 0, r: 0 }, 3);
  const first = cells.map(cell => generateChunk(cell, DEFAULT_CONFIG));
  const second = [...cells].reverse().map(cell => generateChunk(cell, DEFAULT_CONFIG));
  for (const chunk of first) {
    const match = second.find(c => c.key === chunk.key)!;
    assert.equal(chunk.fingerprint, match.fingerprint);
    assert.deepEqual(chunk.positions, match.positions);
  }
  const assets = new Map(); let duplicates = 0;
  for (const chunk of first) for (const asset of chunk.assets) {
    if (assets.has(asset.id)) { assert.deepEqual(assets.get(asset.id), asset); duplicates++; }
    assets.set(asset.id, asset);
  }
  assert.ok(duplicates > 0);
  assert.ok(['pine', 'house', 'bridge'].every(kind => [...assets.values()].some(asset => asset.kind === kind)));
  assert.notEqual(generateChunk({ q: 0, r: 0 }, { ...DEFAULT_CONFIG, seed: 'another-world' }).fingerprint, first[0].fingerprint);
});

test('streaming unloads outside the disk and recreates identical geometry on revisit', () => {
  const manager = new ChunkManager(structuredClone(DEFAULT_CONFIG));
  manager.update(0, 0, 0);
  const fingerprints = [...manager.active.values()].map(c => [c.key, c.fingerprint]);
  for (let step = 1; step <= 30; step++) {
    const p = hexCenter({ q: step, r: -step }, DEFAULT_CONFIG.chunkRadius);
    manager.update(p.x, p.z, step);
    assert.equal(manager.active.size, 7);
    assert.ok([...manager.active.values()].every(c => hexDistance(c.cell, manager.center) <= 1));
  }
  assert.ok(manager.records.size > manager.active.size);
  manager.update(0, 0, 50);
  for (const [key, fingerprint] of fingerprints) {
    assert.equal(manager.active.get(key)!.fingerprint, fingerprint);
    assert.equal(manager.records.get(key)!.visits, 2);
  }
  manager.config.loadRange = 3;
  manager.update(0, 0, 51);
  assert.equal(manager.active.size, 19);
});

test('clock pause, time scale, and observation do not depend on render calls', async () => {
  const clock = new WorldClock({ ...DEFAULT_CONFIG.clock, timeScale: 2 });
  clock.advance(0.5); assert.equal(clock.tick, 1); assert.equal(clock.elapsedSeconds, 1);
  clock.paused = true; clock.advance(1); assert.equal(clock.tick, 1);
  await initializePhysics();
  const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  try {
    advance(world, 1);
    assert.equal(world.clock.tick, 60);
    for (let i = 0; i < 100; i++) world.observation();
    assert.equal(world.clock.tick, 60);
    world.clock.paused = true; advance(world, 1); assert.equal(world.clock.tick, 60);
  } finally { world.dispose(); }
});

test('Rapier walks across a bridge and streams terrain across multiple seams without falling', async () => {
  await initializePhysics();
  const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  try {
    advance(world, 1);
    assert.ok(world.grounded);
    const start = world.camera.z;
    advance(world, 7, { ...idle, forward: 1 });
    assert.ok(world.camera.z > start + 30, `Bridge traversal stopped at ${world.camera.z}`);
    assert.ok(world.camera.y > DEFAULT_CONFIG.terrain.waterLevel + DEFAULT_CONFIG.physics.eyeHeight);
    const plan = villagePlan(0, 0, world.config), access = plan.roads.find(road => road.template === 'bridge-access')!;
    assert.ok(access, 'The demonstration bridge connects to the village');
    world.teleport(access.points[0].x, access.points[0].z);
    advance(world, 1);
    for (const point of access.points.slice(1)) {
      for (let i = 0; i < 180 && Math.hypot(world.camera.x - point.x, world.camera.z - point.z) > 0.7; i++) {
        world.camera.yaw = Math.atan2(world.camera.x - point.x, world.camera.z - point.z);
        world.update(1 / world.config.physics.frequency, { ...idle, forward: 1 });
      }
      assert.ok(Math.hypot(world.camera.x - point.x, world.camera.z - point.z) < 1, 'The projected road remains walkable');
    }
    assert.ok(Math.hypot(world.camera.x - plan.x, world.camera.z - plan.z) < 1);
    assert.ok(world.camera.y > -1);
    assert.equal(world.chunks.active.size, 7);
    assert.ok(world.chunks.records.size > 7);
  } finally { world.dispose(); }
});

test('solid houses block movement; origin rebasing and save restore retain absolute world identity', async () => {
  await initializePhysics();
  const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  let restored: WorldRuntime | undefined;
  try {
    const house = [...world.chunks.assets.values()].find(a => a.kind === 'house')!;
    world.teleport(house.x, house.z - DEFAULT_CONFIG.population.houseWidth * 1.5);
    world.camera.yaw = Math.PI;
    advance(world, 3, { ...idle, forward: 1 });
    assert.ok(world.camera.z < house.z - 1, 'Character must not pass through house');
    const farX = 10000, farZ = 12000;
    world.teleport(farX, farZ);
    advance(world, 1);
    assert.ok(Math.abs(world.origin.x) > 0 && Math.abs(world.origin.z) > 0);
    assert.ok(Math.abs(world.camera.x - farX) < 0.01);
    assert.ok(Math.abs(world.camera.y - terrainHeight(farX, farZ, world.config) - world.config.physics.eyeHeight) < 1);
    const saved = snapshotSchema.parse(JSON.parse(JSON.stringify(world.snapshot(true))));
    restored = new WorldRuntime(saved.config, saved);
    assert.deepEqual(restored.camera, saved.camera);
    assert.equal(restored.clock.tick, saved.tick);
    assert.equal(restored.clock.elapsedSeconds, saved.elapsedSeconds);
    assert.deepEqual(restored.observation().activeChunks, world.observation().activeChunks);
    assert.throws(() => new WorldRuntime(saved.config, { ...saved, generatorVersion: 'unknown' }), /version/);
    const bridge = riverCenter(0, world.config); assert.ok(Number.isFinite(bridge));
  } finally { restored?.dispose(); world.dispose(); }
});

test('invalid configuration is rejected and integration subscribers cannot mutate world observations', () => {
  assert.equal(configSchema.safeParse({ loadRange: 0 }).success, false);
  assert.equal(configSchema.safeParse({ chunkRadius: -1 }).success, false);
  const registry = new IntegrationRegistry();
  const observation = { worldId: 'test', generatorVersion: 'test', tick: 1, worldSeconds: 1,
    camera: { x: 0, y: 1, z: 0, yaw: 0, pitch: 0 }, origin: { x: 0, z: 0 }, activeChunks: [] };
  registry.subscribe(value => value.camera.x = 99);
  registry.subscribe(value => assert.equal(value.camera.x, 0));
  registry.publish(observation); assert.equal(observation.camera.x, 0);
});

test('world state advances without observations and retains physics after the observer leaves', async () => {
  await initializePhysics();
  const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  let restored: WorldRuntime | undefined;
  try {
    const id = world.dropPhysicsObject();
    const initial = structuredClone(world.state.entities.get(id)!);
    advance(world, 0.25);
    assert.ok(world.state.entities.get(id)!.position.y < initial.position.y);
    assert.ok(world.state.entities.get(id)!.linearVelocity.y < 0);
    const beforeObserve = world.snapshot();
    for (let i = 0; i < 100; i++) world.observation();
    assert.deepEqual(world.snapshot().simulation, beforeObserve.simulation);
    assert.equal(world.clock.tick, beforeObserve.tick);
    world.clock.paused = true;
    const saved = snapshotSchema.parse(world.snapshot(true));
    restored = new WorldRuntime(saved.config, saved);
    assert.deepEqual(restored.snapshot().simulation, saved.simulation);
    advance(restored, 1); assert.equal(restored.clock.tick, saved.tick);
    restored.clock.paused = false;
    const entity = structuredClone(restored.state.entities.get(id)!);
    const tick = restored.clock.tick;
    restored.teleport(8000, 8000);
    assert.equal(restored.clock.tick, tick, 'Camera teleport must not advance simulation');
    assert.equal(restored.state.bodies.has(id), true);
    advance(restored, 0.1);
    const remote = structuredClone(restored.state.entities.get(id)!);
    assert.ok(remote.position.y < entity.position.y, 'Offscreen body must continue falling');
    restored.teleport(saved.camera.x, saved.camera.z, saved.camera.y);
    assert.equal(restored.state.bodies.has(id), true);
    assert.deepEqual(restored.state.entities.get(id)!.position, remote.position);
  } finally { restored?.dispose(); world.dispose(); }
});

test('clock speed drives fixed physics ticks while keeping walk speed independent of time scale', async () => {
  await initializePhysics();
  const normal = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  const fast = new WorldRuntime(configSchema.parse({ clock: { timeScale: 2 } }));
  try {
    advance(normal, 1); advance(fast, 1);
    assert.equal(normal.clock.tick, 60); assert.equal(fast.clock.tick, 120);
    assert.ok(Math.abs(fast.clock.elapsedSeconds - 2) < 1e-6);
    const start = [normal.camera.z, fast.camera.z];
    advance(normal, 1, { ...idle, forward: 1 }); advance(fast, 1, { ...idle, forward: 1 });
    assert.ok(Math.abs((normal.camera.z - start[0]) - (fast.camera.z - start[1])) < 0.2);
    fast.config.clock.timeScale = 0;
    const tick = fast.clock.tick; advance(fast, 1); assert.equal(fast.clock.tick, tick);
  } finally { normal.dispose(); fast.dispose(); }
});

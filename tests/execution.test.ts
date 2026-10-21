import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializePhysics, WorldRuntime } from '../packages/adapters/src/rapier/runtime';
import { DEFAULT_CONFIG, configSchema } from '../packages/protocol/src/config';
import { snapshotSchema } from '../packages/protocol/src/contracts';
const idle = { forward: 0, right: 0, sprint: false, jump: false };
test('observer can move while paused; queued physics commands execute on resume', async () => {
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  try {
    world.clock.paused = true; const before = world.snapshot(), id = world.dropPhysicsObject();
    world.update(0.5, { ...idle, forward: 1 });
    assert.equal(world.clock.tick, before.tick); assert.notEqual(world.camera.z, before.camera.z);
    assert.equal(world.state.entities.has(id), false);
    world.clock.paused = false; world.advanceWorld(1 / 60); assert.ok(world.state.bodies.has(id));
  } finally { world.dispose(); }
});
test('fixed step budget exposes backlog and eventually executes all scheduled steps', async () => {
  await initializePhysics(); const world = new WorldRuntime(configSchema.parse({ execution: { maxStepsPerTurn: 4 } }));
  try { world.advanceWorld(1); assert.equal(world.clock.tick, 4); assert.equal(world.pendingSteps, 56);
    world.config.clock.timeScale = 0; world.advanceWorld(10); assert.equal(world.clock.tick, 4); assert.equal(world.pendingSteps, 56); world.config.clock.timeScale = 1;
    while (world.pendingSteps) world.advanceWorld(0); assert.equal(world.clock.tick, 60); assert.ok(Math.abs(world.clock.elapsedSeconds - 1) < 1e-10);
  } finally { world.dispose(); }
});
test('exact physics checkpoint resumes active contacts and preserves queued commands without offline catchup', async () => {
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG)); let restored: WorldRuntime | undefined;
  try {
    const id = world.dropPhysicsObject(); for (let i = 0; i < 20; i++) world.advanceWorld(1 / 60);
    assert.throws(() => new WorldRuntime(world.config, world.snapshot()), /complete physics checkpoint/);
    const saved = snapshotSchema.parse(JSON.parse(JSON.stringify(world.snapshot(true))));
    assert.throws(() => new WorldRuntime(saved.config, { ...saved, execution: { ...saved.execution!, build: 'incompatible-artifact' } }), /build is incompatible/);
    restored = new WorldRuntime(saved.config, saved); assert.equal(restored.clock.tick, saved.tick);
    for (let i = 0; i < 120; i++) { world.advanceWorld(1 / 60); restored.advanceWorld(1 / 60); }
    const a = world.state.entities.get(id)!, b = restored.state.entities.get(id)!;
    assert.deepEqual(b.position, a.position); assert.deepEqual(b.linearVelocity, a.linearVelocity); assert.equal(restored.clock.tick, world.clock.tick);
    world.clock.paused = true; const pending = world.dropPhysicsObject(); const queued = world.snapshot(true); const other = new WorldRuntime(queued.config, queued);
    try { assert.equal(other.state.entities.has(pending), false); other.clock.paused = false; other.advanceWorld(1 / 60); assert.ok(other.state.entities.has(pending)); } finally { other.dispose(); }
  } finally { restored?.dispose(); world.dispose(); }
});

test('creation budget rejects additional automatic examples while keeping existing physics running', async () => {
  await initializePhysics(); const world = new WorldRuntime(configSchema.parse({ physics: { maxActiveBodies: 8 } }));
  try {
    while (world.state.entities.size < world.config.physics.maxActiveBodies) world.dropPhysicsObject();
    world.state.sync(world.chunks.active, new Map([['budget-bridge', { id: 'budget-bridge', kind: 'bridge', x: world.camera.x, y: 0, z: world.camera.z, rotation: 0, scale: 1, variant: 0 }]]), world.config, world.clock.tick);
    assert.equal(world.state.entities.size, 8); assert.ok(world.state.blockedSpawns.has('crate:budget-bridge'));
    const tick = world.clock.tick; world.advanceWorld(1 / 60); assert.equal(world.clock.tick, tick + 1);
  } finally { world.dispose(); }
});

test('camera rebasing and repeated queries cannot rewrite entity positions at a paused tick', async () => {
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  try {
    world.dropPhysicsObject(); world.advanceWorld(1 / 60); world.clock.paused = true;
    const before = world.state.snapshot(), tick = world.clock.tick;
    world.teleport(8000, 8000);
    for (let i = 0; i < 10; i++) { world.observation(); world.snapshot(); }
    for (const entity of before) assert.deepEqual(world.state.entities.get(entity.id), entity);
    assert.equal(world.clock.tick, tick);
  } finally { world.dispose(); }
});

test('offset static supports remain resident beyond entity neighbor rings and survive exact restore', async () => {
  await initializePhysics(); const world = new WorldRuntime(configSchema.parse({ chunkRadius: 12, loadRange: 6 })); let restored: WorldRuntime | undefined;
  try {
    world.teleport(0, 0);
    for (const id of [...world.state.entities.keys()]) { world.content.state.deletedIds.push(id); world.state.replace(id, undefined); }
    world.content.state.additions['wide-support'] = { id: 'wide-support', kind: 'custom', x: 0, y: 200, z: 0, scale: 1, rotation: 0, variant: 0,
      design: { label: 'Offset support', materials: { support: { label: 'Support', color: '#888888', roughness: 0.9 } }, parts: [{ shape: 'box', size: [1, 1, 1], position: [0, 0, 0], material: 'support' }], effect: 'none', collider: null, colliders: [{ halfExtents: [32, 1, 8], center: [64, 0, 0] }] } };
    world.refreshEditedObjects();
    const id = world.dropPhysicsObject(), entity = structuredClone(world.state.entities.get(id)!);
    entity.position = { x: 90, y: 202, z: 0 }; entity.linearVelocity = { x: 0, y: 0, z: 0 }; world.state.replace(id, entity);
    world.teleport(90, 0); for (let i = 0; i < 180; i++) world.advanceWorld(1 / 60);
    world.teleport(5000, 5000); for (let i = 0; i < 180; i++) world.advanceWorld(1 / 60);
    assert.ok(world.simulationChunks.has('0,0'), 'Existing support was released with its owner chunk');
    assert.ok(world.state.entities.get(id)!.position.y > 201);
    assert.ok([...world.residencyReasons.get('0,0')!].some(reason => reason.startsWith('collider:wide-support:entity:')));
    const saved = world.snapshot(true); restored = new WorldRuntime(saved.config, saved);
    for (let i = 0; i < 180; i++) restored.advanceWorld(1 / 60);
    assert.ok(restored.state.entities.get(id)!.position.y > 201, 'Support dependencies were lost on restore');
    assert.ok(restored.simulationChunks.has('0,0'));
  } finally { restored?.dispose(); world.dispose(); }
});

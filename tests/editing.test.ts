import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { contentPackageSchema, type EditPlan } from '../packages/protocol/src/content';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { WorldRuntime, initializePhysics } from '../packages/adapters/src/rapier/runtime';
import { snapshotSchema } from '../packages/protocol/src/contracts';
import { worldToHex, hexKey } from '../packages/world/src/hex';

const pack = async (name: string) => contentPackageSchema.parse(JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')));
function plan(world: WorldRuntime, action: EditPlan['action'], rest: Partial<EditPlan> = {}): EditPlan {
  return { worldId: world.id, requestId: crypto.randomUUID(), action, label: action, referenceIds: [], ...rest };
}
function space(world: WorldRuntime): { x: number; y: number; z: number } {
  for (const c of world.chunks.active.values()) for (let x = c.center.x - 20; x < c.center.x + 20; x += 4) for (let z = c.center.z - 20; z < c.center.z + 20; z += 4) {
    const y = world.groundHeight(x, z);
    if (y < world.config.terrain.waterLevel + 1 || Math.hypot(x - world.camera.x, z - world.camera.z) < 8) continue;
    if ([...world.chunks.assets.values()].every(a => Math.hypot(a.x - x, a.z - z) > 7)) return { x, y, z };
  }
  throw new Error('No clear test anchor');
}

test('object transactions create, move across cells, delete, undo and restore without changing base terrain or clock', async () => {
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG)); world.clock.paused = true;
  try {
    const bench = await pack('bench'), before = world.snapshot(), point = space(world);
    const create = plan(world, 'create', { point, asset: 'bench', constraint: 'wood bench', referenceIds: ['a'.repeat(64)] });
    const result = world.editor.apply(create, bench), id = result.id!;
    assert.equal(world.chunks.assets.get(id)?.design?.label, 'Wooden bench');
    assert.equal(world.content.state.constraints.find(c => c.objectId === id)?.referenceIds[0], 'a'.repeat(64));
    assert.equal(world.editor.apply(create, bench).revision, result.revision);
    assert.throws(() => world.editor.apply(plan(world, 'delete', { targetId: id, expectedVersion: 0 })), /Another instruction/);
    const cell = hexKey(worldToHex(point.x, point.z, world.config.chunkRadius));
    const move = plan(world, 'move', { targetId: id, expectedVersion: 1, delta: { x: 0, y: 0, z: 1 } });
    world.editor.apply(move); assert.equal(world.chunks.assets.get(id)?.z, point.z + 1);
    world.editor.apply(plan(world, 'delete', { targetId: id, expectedVersion: 2 }));
    assert.ok(!world.chunks.assets.has(id));
    world.teleport(1000, 800); world.teleport(before.camera.x, before.camera.z, before.camera.y);
    assert.ok(!world.chunks.assets.has(id));
    const undoId = crypto.randomUUID(); world.editor.undo(undoId); assert.equal(world.chunks.assets.get(id)?.z, point.z + 1);
    const undone = world.content.state.revision; world.editor.undo(undoId); assert.equal(world.content.state.revision, undone);
    world.editor.undo(); assert.equal(world.chunks.assets.get(id)?.z, point.z);
    assert.ok(world.chunks.active.get(cell)?.assets.some(a => a.id === id));
    const far = [...world.chunks.active.values()].find(c => c.key !== cell && c.biome !== 'river')!;
    let destination;
    for (let dx = -6; dx <= 6 && !destination; dx += 3) for (let dz = -6; dz <= 6 && !destination; dz += 3) {
      const x = far.center.x + dx, z = far.center.z + dz, candidate = { ...world.chunks.assets.get(id)!, x, z, y: world.groundHeight(x, z) };
      try { world.validatePlacement(candidate, id); destination = candidate; } catch { /* Search a real clear cell. */ }
    }
    assert.ok(destination); world.editor.apply(plan(world, 'move', { targetId: id, expectedVersion: world.editor.version(id), point: destination }));
    assert.ok(world.chunks.active.get(hexKey(worldToHex(destination.x, destination.z, world.config.chunkRadius)))?.assets.some(a => a.id === id));
    world.editor.undo();
    const saved = snapshotSchema.parse(world.snapshot(true)), restored = new WorldRuntime(saved.config, saved);
    assert.equal(restored.chunks.assets.get(id)?.design?.label, 'Wooden bench'); restored.editor.undo(); assert.ok(!restored.chunks.assets.has(id)); restored.dispose();
    for (const c of before.chunks) assert.equal(world.chunks.records.get(`${c.q},${c.r}`)?.fingerprint, c.fingerprint);
    assert.equal(world.clock.tick, before.tick);
  } finally { world.dispose(); }
});

test('base object replacement/deletion survives revisits; undo restores physics and failed placement is atomic', async () => {
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG)); world.clock.paused = true;
  try {
    const tree = [...world.chunks.assets.values()].find(a => a.kind === 'pine' && Math.hypot(a.x - world.camera.x, a.z - world.camera.z) > 6)!;
    const camera = { ...world.camera }, cherry = await pack('cherry');
    world.editor.apply(plan(world, 'replace', { targetId: tree.id, expectedVersion: 0, asset: 'cherry', constraint: 'pink petals' }), cherry);
    world.editor.apply(plan(world, 'delete', { targetId: tree.id, expectedVersion: 1 }));
    world.teleport(1000, 900); world.teleport(camera.x, camera.z, camera.y);
    assert.ok(!world.chunks.assets.has(tree.id)); world.editor.undo(); assert.equal(world.chunks.assets.get(tree.id)?.design?.effect, 'petals');
    world.editor.undo(); assert.equal(world.chunks.assets.get(tree.id)?.design, undefined);
    const before = world.snapshot();
    assert.throws(() => world.editor.apply(plan(world, 'create', { asset: 'bench', point: { x: world.camera.x, y: world.camera.y - world.config.physics.eyeHeight, z: world.camera.z } }), cherry), /asset/);
    assert.deepEqual(world.content.state, before.content);
    const bench = await pack('bench');
    assert.throws(() => world.editor.apply(plan(world, 'create', { asset: 'bench', point: { x: world.camera.x, y: world.groundHeight(world.camera.x, world.camera.z), z: world.camera.z } }), bench), /collid|overlap/);
    assert.deepEqual(world.content.state, before.content);
    const dynamic = [...world.state.entities.values()][0];
    if (dynamic) { world.editor.apply(plan(world, 'delete', { targetId: dynamic.id })); world.update(1, { forward: 0, right: 0, sprint: false, jump: false });
      assert.ok(!world.state.entities.has(dynamic.id)); world.editor.undo(); assert.ok(world.state.entities.has(dynamic.id)); }
  } finally { world.dispose(); }
});

test('undoing a constraint preserves subsequent physical motion and unrelated objects', async () => {
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  try {
    const id = world.dropPhysicsObject();
    world.editor.apply({ requestId: crypto.randomUUID(), worldId: world.id, action: 'constraint', targetId: id, expectedVersion: 0, label: '外观约束', constraint: 'wooden crate', referenceIds: [] });
    for (let i = 0; i < 10; i++) world.advanceWorld(1 / 60);
    const current = structuredClone(world.state.entities.get(id)!); const tick = world.clock.tick;
    world.editor.undo();
    assert.deepEqual(world.state.entities.get(id), current); assert.equal(world.clock.tick, tick);
    assert.equal(world.events.at(-1)?.operation, 'undo'); assert.equal(world.events.at(-1)?.worldId, world.id);
  } finally { world.dispose(); }
});

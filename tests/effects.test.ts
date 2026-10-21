import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WorldEffects } from '../packages/viewer/src/world-effects';
import { WorldRuntime, initializePhysics } from '../packages/adapters/src/rapier/runtime';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { contentPackageSchema } from '../packages/protocol/src/content';

function positions(effects: WorldEffects): number[] {
  return Array.from(effects.points.geometry.attributes.position.array.slice(0, effects.points.geometry.drawRange.count * 3));
}

test('lamp particles stay anchored across camera movement, rebasing and revisits; time and object edits own their motion', async () => {
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG)), effects = new WorldEffects();
  try {
    world.clock.paused = true;
    const lamp = contentPackageSchema.parse(JSON.parse(await readFile(new URL('./fixtures/lantern.json', import.meta.url), 'utf8')));
    const tree = [...world.chunks.assets.values()].find(a => a.kind === 'pine' && Math.hypot(a.x - world.camera.x, a.z - world.camera.z) > 8)!;
    world.installContent(lamp, { targetId: tree.id, asset: 'lantern' });
    assert.equal(world.content.weatherPackages.length, 0, 'an object edit must not enable global package weather');
    effects.update(world); const before = positions(effects), camera = { ...world.camera };
    assert.equal(before.length, 96 * 3);
    for (let i = 0; i < before.length; i += 3) assert.ok(Math.hypot(before[i] - tree.x, before[i + 2] - tree.z) < tree.scale * 7);
    world.camera.x += 4; world.camera.y += 2; world.camera.yaw += 1;
    effects.update(world); assert.deepEqual(positions(effects), before);
    const origin = { ...world.origin }; world.origin.x += 256; world.origin.z -= 128;
    effects.update(world); const rebased = positions(effects);
    for (let i = 0; i < before.length; i += 3) {
      assert.ok(Math.abs(rebased[i] + 256 - before[i]) < 0.0001);
      assert.ok(Math.abs(rebased[i + 2] - 128 - before[i + 2]) < 0.0001);
    }
    Object.assign(world.origin, origin);
    world.teleport(1400, 1000); effects.update(world); assert.equal(positions(effects).length, 0);
    world.teleport(camera.x, camera.z, camera.y); effects.update(world); assert.deepEqual(positions(effects), before);
    world.clock.elapsedSeconds = 1; effects.update(world); assert.notDeepEqual(positions(effects), before);
    world.editor.apply({ requestId: crypto.randomUUID(), worldId: world.id, action: 'delete', targetId: tree.id, label: 'delete lamp', referenceIds: [] });
    effects.update(world); assert.equal(positions(effects).length, 0);
    world.editor.undo(); effects.update(world); assert.equal(positions(effects).length, before.length);
  } finally { effects.dispose(); world.dispose(); }
});

test('global weather is chunk-seeded and camera independent, including shared chunks after streaming', async () => {
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG)), effects = new WorldEffects();
  try {
    world.clock.paused = true;
    world.content.install(contentPackageSchema.parse({ protocol: 1, id: 'weather-test', version: '1.0.0', title: 'Snow', description: '', weather: { kind: 'snow', density: 0.1 } }), true);
    effects.update(world); const before = positions(effects);
    assert.equal(before.length, 7 * 16 * 3);
    world.camera.x += 5; world.camera.z -= 3; effects.update(world); assert.deepEqual(positions(effects), before);
    const firstCell = [...world.chunks.active.values()].sort((a, b) => a.key.localeCompare(b.key))[0];
    const shared = before.slice(0, 16 * 3);
    world.teleport(firstCell.center.x, firstCell.center.z); effects.update(world);
    const after = positions(effects);
    for (let i = 0; i < shared.length; i += 3) {
      assert.ok(after.some((x, j) => j % 3 === 0 && Math.abs(x - shared[i]) < 0.001 && Math.abs(after[j + 1] - shared[i + 1]) < 0.001 && Math.abs(after[j + 2] - shared[i + 2]) < 0.001));
    }
  } finally { effects.dispose(); world.dispose(); }
});

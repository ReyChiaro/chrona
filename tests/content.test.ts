import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePlugin, validatePackage, ContentRegistry } from '../apps/api/src/content-registry';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { contentPackageSchema, packageKey } from '../packages/protocol/src/content';
import { snapshotSchema } from '../packages/protocol/src/contracts';
import { WorldRuntime, initializePhysics } from '../packages/adapters/src/rapier/runtime';
import { generateChunk } from '../packages/world/src/generator';
import { generateContentChunk } from '../packages/world/src/content';
import { surfaceHeight } from '../packages/world/src/surface';

const load = async (name: string) => contentPackageSchema.parse(JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')));

test('data-only plugin compiler rejects executable code; releases are immutable and seams match mixed old/new chunks', async () => {
  const pack = await load('cherry'), source = `export default defineContent(${JSON.stringify(pack)});`;
  assert.deepEqual(compilePlugin(source), pack);
  for (const bad of ['export default defineContent(fetch("/"));', 'import "x"; export default defineContent({});', 'export default defineContent({id:process.env});', 'export default defineContent({id:"x",id:"y"});']) assert.throws(() => compilePlugin(bad));
  const report = validatePackage(pack); assert.ok(report.passed && report.boundarySamples > 0);
  for (const cell of [{ q: 0, r: 0 }, { q: -1, r: 0 }, { q: 10, r: 7 }]) {
    const base = generateChunk(cell, DEFAULT_CONFIG), next = generateContentChunk(cell, DEFAULT_CONFIG, [pack]);
    assert.deepEqual(base.boundary, next.boundary); assert.equal(base.fingerprint, next.fingerprint);
    for (let i = 0; i < next.positions.length; i += 3) assert.ok(Number.isFinite(surfaceHeight(next, next.center.x + next.positions[i], next.center.z + next.positions[i + 2])));
  }
  const root = await mkdtemp(join(tmpdir(), 'world-content-'));
  try {
    const registry = new ContentRegistry(root), draft = await registry.stage(source);
    await registry.publish(draft.id); await registry.publish(draft.id);
    const changed = await registry.stage(`export default defineContent(${JSON.stringify({ ...pack, title: 'changed' })});`);
    await assert.rejects(() => registry.publish(changed.id), /immutable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('an object edit rejects a player collision without advancing a paused world or installing the package', async () => {
  await initializePhysics();
  const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG)); world.clock.paused = true;
  try {
    const tree = [...world.chunks.assets.values()].find(a => a.kind === 'pine')!;
    world.teleport(tree.x, tree.z, tree.y + world.config.physics.eyeHeight);
    const cherry = await load('cherry');
    assert.throws(() => world.installContent(cherry, { targetId: tree.id, asset: 'cherry' }), /overlap/);
    assert.equal(world.content.state.packages.length, 0); assert.equal(world.clock.tick, 0);
  } finally { world.dispose(); }
});

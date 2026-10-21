import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraPresentation } from '../packages/adapters/src/runtime/presentation';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { ChunkManager } from '../packages/world/src/chunks';
import { generateChunk } from '../packages/world/src/generator';
import { hexCenter } from '../packages/world/src/hex';

const pose = { x: 0, y: 2, z: 0, yaw: 0, pitch: 0 };

test('display camera moves between authoritative samples without changing saved positions', () => {
  const presentation = new CameraPresentation();
  presentation.receive(pose, 0, 40, 1, 0);
  const next = { ...pose, x: 4 };
  presentation.receive(next, 40, 40, 1, 0);
  assert.equal(presentation.sample(50).x, 1);
  assert.equal(presentation.sample(60).x, 2);
  assert.equal(presentation.sample(80).x, 4);
  assert.equal(presentation.sample(1000).x, 4, 'never extrapolate through colliders');
  assert.equal(next.x, 4);
  assert.equal(pose.x, 0);
});

test('look feedback is immediate, keeps pitch clamping order and survives delayed acknowledgements', () => {
  const presentation = new CameraPresentation();
  presentation.receive(pose, 0, 40, 1, 0);
  presentation.turn(20, -10000, .002, 1);
  const first = { ...presentation.pendingLook! };
  presentation.turn(10, 50, .002, 2);
  const latest = { ...presentation.pendingLook! };
  assert.equal(presentation.sample(2).yaw, -.06);
  assert.ok(Math.abs(latest.pitch - (Math.PI * .47 - .1)) < 1e-10);
  presentation.receive({ ...pose, yaw: first.yaw, pitch: first.pitch }, 20, 40, 1, first.sequence);
  assert.equal(presentation.sample(20).yaw, latest.yaw, 'old worker state cannot undo newer input');
  presentation.receive({ ...pose, yaw: latest.yaw, pitch: latest.pitch }, 40, 40, 1, latest.sequence);
  assert.equal(presentation.pendingLook, undefined);
  assert.equal(presentation.sample(40).yaw, latest.yaw);
});

test('teleports snap the display and discard old local input; remote yaw takes the shortest path', () => {
  const presentation = new CameraPresentation();
  presentation.receive({ ...pose, yaw: Math.PI - .1 }, 0, 40, 1, 0);
  presentation.receive({ ...pose, yaw: -Math.PI + .1 }, 40, 40, 1, 0);
  assert.ok(Math.abs(presentation.sample(60).yaw - Math.PI) < 1e-10);
  presentation.turn(10, 10, .002, 61);
  presentation.receive({ ...pose, x: 10000, yaw: 0 }, 62, 40, 2, 0);
  assert.equal(presentation.sample(62).x, 10000);
  assert.equal(presentation.sample(62).yaw, 0);
  assert.equal(presentation.pendingLook, undefined);
});

test('bounded preparation keeps world history unchanged and removes generation from adjacent crossings', () => {
  let generated = 0;
  const chunks = new ChunkManager(structuredClone(DEFAULT_CONFIG), (cell, config) => {
    generated++;
    return generateChunk(cell, config);
  });
  chunks.update(0, 0, 0);
  const before = structuredClone([...chunks.records]);
  while (chunks.prepareNext(0, 0)) {}
  assert.deepEqual([...chunks.records], before);
  assert.equal(chunks.active.size, 7);
  const count = generated, original = new Map(chunks.active);
  const next = hexCenter({ q: 1, r: 0 }, DEFAULT_CONFIG.chunkRadius);
  const change = chunks.update(next.x, next.z, 1);
  assert.equal(generated, count);
  assert.equal(change.added.length, 3);
  assert.equal(change.removed.length, 3);
  for (const [key, chunk] of chunks.active) if (original.has(key)) assert.equal(chunk, original.get(key));
  chunks.update(0, 0, 2);
  assert.equal(generated, count, 'recently removed geometry is reused on revisit');
  assert.equal(chunks.records.get('0,0')!.visits, 1);
});

test('invalidating prepared geometry picks up content edits before an unvisited chunk is activated', () => {
  let version = 0;
  const chunks = new ChunkManager(structuredClone(DEFAULT_CONFIG), (cell, config) => {
    const chunk = generateChunk(cell, config);
    for (const asset of chunk.assets) asset.variant = version;
    return chunk;
  });
  chunks.update(0, 0, 0);
  while (chunks.prepareNext(0, 0)) {}
  version = 1;
  chunks.invalidatePrepared();
  const next = hexCenter({ q: 1, r: 0 }, DEFAULT_CONFIG.chunkRadius);
  const change = chunks.update(next.x, next.z, 1);
  assert.ok(change.added.flatMap(chunk => chunk.assets).every(asset => asset.variant === 1));
});

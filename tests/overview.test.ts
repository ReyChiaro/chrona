import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { generateChunk } from '../packages/world/src/generator';
import { buildOverviewMesh, overviewSummary, ByteCache } from '../packages/viewer/src/overview-data';

test('overview LODs preserve the original boundary and never alter canonical chunk data', () => {
  const cell = { q: -3, r: 4 }, chunk = generateChunk(cell, DEFAULT_CONFIG);
  const detail = buildOverviewMesh(cell, DEFAULT_CONFIG, 'detail');
  const surface = buildOverviewMesh(cell, DEFAULT_CONFIG, 'surface');
  assert.ok(surface.positions.length < detail.positions.length / 2);
  for (const mesh of [detail, surface]) {
    assert.equal(mesh.positions.length, mesh.colors.length); assert.equal(mesh.positions.length, mesh.normals.length);
    assert.ok(mesh.positions.every(Number.isFinite));
    for (const point of chunk.boundary) {
      let found = false;
      for (let i = 0; i < mesh.positions.length; i += 3) if (Math.abs(mesh.positions[i] - point.x) < 1e-5 && Math.abs(mesh.positions[i + 1] - point.y) < 1e-5 && Math.abs(mesh.positions[i + 2] - point.z) < 1e-5) { found = true; break; }
      assert.ok(found, 'Both LODs must retain every shared boundary sample');
    }
  }
  assert.equal(generateChunk(cell, DEFAULT_CONFIG).fingerprint, chunk.fingerprint);
  assert.equal(overviewSummary(cell, DEFAULT_CONFIG).key, chunk.key);
  const summary = overviewSummary(cell, DEFAULT_CONFIG);
  assert.equal(summary.corners.length, 6);
  summary.corners.forEach((height, i) => assert.ok(Math.abs(height - chunk.boundary[i * DEFAULT_CONFIG.subdivisions].y) < 1e-5));
});

test('overview cache evicts by recency and bytes, releases resources, and can lower its budget', () => {
  const released: string[] = [], cache = new ByteCache<string>(10, value => released.push(value));
  cache.set('a', 'A', 4); cache.set('b', 'B', 4);
  assert.equal(cache.get('a'), 'A');
  cache.set('c', 'C', 4);
  assert.equal(cache.get('b'), undefined); assert.deepEqual(released, ['B']); assert.equal(cache.bytes, 8);
  cache.limit = 4; cache.trim(); assert.equal(cache.bytes, 4);
  assert.equal(cache.get('a'), undefined); assert.equal(cache.get('c'), 'C');
  cache.set('large', 'large', 20); assert.equal(cache.bytes, 0);
  cache.clear(); assert.ok(released.includes('A') && released.includes('C') && released.includes('large'));
});

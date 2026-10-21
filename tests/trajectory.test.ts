import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampledFrameCount, trajectoryPlan } from '../packages/protocol/src/trajectory';
import { triangleContours } from '../packages/viewer/src/terrain-map';

const limits = { fps: 24, minDuration: 5, maxDuration: 15, frameMultiple: 17, frameOffset: 5 };

test('a long take retains its complete route by downsampling onto an independent model timeline', () => {
  const full = trajectoryPlan(2400, 1, limits);
  assert.equal(full.valid, false);
  const compact = trajectoryPlan(2400, full.suggestedStride, limits);
  assert.equal(compact.valid, true);
  assert.ok(compact.outputDuration <= limits.maxDuration);
  assert.equal(compact.sampledFrames, Math.floor(2399 / full.suggestedStride) + 2);
  assert.equal(trajectoryPlan(241, 3, limits).sampledFrames, 81);
  assert.equal(trajectoryPlan(242, 3, limits).sampledFrames, 82);
  const short = trajectoryPlan(20, 1, limits);
  assert.ok(short.outputDuration >= limits.minDuration);
  assert.ok(short.paddingFrames > 0);
});

test('unified sampling retains the complete route independently from segment length', () => {
  assert.equal(sampledFrameCount(2400, 1), 2400);
  assert.equal(sampledFrameCount(241, 3), 81);
  assert.equal(sampledFrameCount(242, 3), 82);
  assert.equal(sampledFrameCount(0, 1), 0);
});

test('terrain contours intersect the proxy surface at exact elevations and omit underwater levels', () => {
  const segments = triangleContours([{ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }, { x: 0, y: 10, z: 10 }], 2, 1);
  assert.equal(segments.length, 4);
  for (const [a, b] of segments) {
    assert.equal(a.y, b.y); assert.equal(a.y % 2, 0);
    assert.equal(a.x + a.z, a.y); assert.equal(b.x + b.z, b.y);
  }
});

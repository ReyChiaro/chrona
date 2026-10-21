import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { gradientNoise } from '../packages/world/src/random';
import { peaksAndValleys, terrainSignals } from '../packages/world/src/landforms';
import { riverCenter, terrainHeight } from '../packages/world/src/terrain';
import { villagePlan } from '../packages/world/src/settlements';
import { naturalTerrainHeight } from '../packages/world/src/geography';

function grade(x: number, z: number, config = DEFAULT_CONFIG): number {
  return Math.hypot((terrainHeight(x + 1, z, config) - terrainHeight(x - 1, z, config)) / 2,
    (terrainHeight(x, z + 1, config) - terrainHeight(x, z - 1, config)) / 2);
}

test('seeded signal fields remain smooth at positive, negative and distant coordinates', () => {
  for (const seed of ['cedar-valley', 'alpine-walk']) for (const at of [-10000, -1, 0, 1, 10000]) {
    const value = (x: number) => gradientNoise(seed, 'continuity', x, at * 0.73);
    const delta = 0.0001;
    assert.ok(Math.abs(value(at - delta) - value(at + delta)) < 0.001);
    const left = (value(at) - value(at - delta)) / delta, right = (value(at + delta) - value(at)) / delta;
    assert.ok(Math.abs(left - right) < 0.01);
    assert.deepEqual(terrainSignals(at * 77, at * 33, structuredClone(DEFAULT_CONFIG)), terrainSignals(at * 77, at * 33, DEFAULT_CONFIG));
  }
  assert.ok(Math.abs(peaksAndValleys(0) + 1) < 1e-10);
  assert.ok(Math.abs(peaksAndValleys(2 / 3) - 1) < 1e-10);
  assert.equal(peaksAndValleys(-0.4), peaksAndValleys(0.4));
  assert.notDeepEqual(terrainSignals(27, -64, DEFAULT_CONFIG), terrainSignals(27, -64, { ...DEFAULT_CONFIG, seed: 'new-seed' }));
});

test('default terrain retains tall mountains without narrow walls across several seeds', () => {
  for (const seed of ['cedar-valley', 'alpine-walk', 'wide-meadows', 'negative-world']) {
    const config = { ...DEFAULT_CONFIG, seed }, slopes: number[] = [];
    let lowest = Infinity, highest = -Infinity;
    // A fixed 2 km square includes riverbanks, village boundaries, foothills and peaks.
    for (let x = -1000; x <= 1000; x += 20) for (let z = -1000; z <= 1000; z += 20) {
      const height = terrainHeight(x, z, config);
      assert.ok(Number.isFinite(height)); lowest = Math.min(lowest, height); highest = Math.max(highest, height);
      slopes.push(grade(x, z, config));
    }
    slopes.sort((a, b) => a - b);
    assert.ok(highest - lowest > 75, `${seed}: preserve mountain relief`);
    assert.ok(slopes[Math.floor(slopes.length * 0.95)] < 1.15, `${seed}: 95th percentile grade`);
    assert.ok(slopes.at(-1)! < 3, `${seed}: no narrow terrain walls`);
  }
});

test('foundations conform locally without flattening an entire region or river corridor', () => {
  const present = configSchema.parse({ population: { villageProbability: 1 } });
  for (let rx = -1; rx <= 1; rx++) for (let rz = -1; rz <= 1; rz++) {
    const plan = villagePlan(rx, rz, present);
    for (const house of plan.houses) {
      const heights = [-1, 1].flatMap(dx => [-1, 1].map(dz => {
        const x = dx * present.population.houseWidth * house.scale / 2, z = dz * present.population.houseWidth * house.scale * 0.42;
        return terrainHeight(house.x + x * Math.cos(house.rotation) + z * Math.sin(house.rotation),
          house.z - x * Math.sin(house.rotation) + z * Math.cos(house.rotation), present);
      }));
      assert.ok(Math.min(...heights) > present.terrain.waterLevel);
      assert.ok(Math.max(...heights) - Math.min(...heights) < 0.1, 'Foundations sit on a nearly level terrace');
    }
  }
  let untouched = 0;
  for (let x = -400; x <= 400; x += 20) for (let z = -400; z <= 400; z += 20) {
    if (terrainHeight(x, z, present) === naturalTerrainHeight(x, z, present)) untouched++;
  }
  assert.ok(untouched > 1500, 'Most of the terrain remains natural, including inside settlement regions');
  const noHills = configSchema.parse({ terrain: { hillHeight: 0 } });
  for (let x = -100; x <= 100; x += 20) {
    const z = riverCenter(x, present) + 55;
    assert.ok(naturalTerrainHeight(x, z, present) - naturalTerrainHeight(x, z, noHills) > 3, 'Near-view relief is independent of broad mountains');
  }
});

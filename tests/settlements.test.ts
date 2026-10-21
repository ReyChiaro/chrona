import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, DEFAULT_CONFIG } from '../packages/protocol/src/config';
import { villagePlan, roadDistance, villagesNear } from '../packages/world/src/settlements';
import { naturalTerrainHeight, riverCenter } from '../packages/world/src/geography';
import { distance, onLand } from '../packages/world/src/road-planning';
import { generateChunk } from '../packages/world/src/generator';
import { hexDisk, hexKey, worldToHex } from '../packages/world/src/hex';
import { projectRoads } from '../packages/viewer/src/road-geometry';

test('2D settlement candidates produce inland villages, varied orientations and finite connected streets', () => {
  const plans = [];
  for (let rx = -2; rx <= 2; rx++) for (let rz = -2; rz <= 2; rz++) plans.push(villagePlan(rx, rz, DEFAULT_CONFIG));
  const present = plans.filter(plan => plan.present);
  assert.ok(present.some(plan => plan.z < -150 && plan.houses.length > 3));
  assert.ok(present.some(plan => plan.z > 150 && plan.houses.length > 3));
  assert.ok(present.filter(plan => Math.abs(plan.z - riverCenter(plan.x, DEFAULT_CONFIG)) > 100).length > 10);
  const headings = new Set<number>(), templates = new Set<string>();
  let bends = 0;
  for (const plan of present) {
    assert.doesNotThrow(() => JSON.stringify(plan));
    assert.ok(plan.roads.length < 50);
    const allPoints = plan.roads.flatMap(road => road.points);
    for (const road of plan.roads) {
      templates.add(road.template);
      const [a, b] = road.points; headings.add(Math.round(Math.atan2(b.z - a.z, b.x - a.x) * 10));
      assert.ok(road.depth <= DEFAULT_CONFIG.population.roadDepth);
      assert.ok(road.points.every(point => onLand(point, DEFAULT_CONFIG)));
      for (let i = 1; i < road.points.length; i++) {
        const from = road.points[i - 1], to = road.points[i];
        if (road.template !== 'doorstep') assert.ok(Math.abs(to.y - from.y) / distance(from, to) <= DEFAULT_CONFIG.population.roadMaxSlope + 1e-8);
      }
      if (road.points.length > 2) {
        const end = road.points.at(-1)!, direction = { x: end.x - a.x, z: end.z - a.z };
        if (road.points.some(point => Math.abs(direction.x * (point.z - a.z) - direction.z * (point.x - a.x)) / Math.hypot(direction.x, direction.z) > 0.5)) bends++;
      }
      // Every road attaches at the village root, another connector, or the far bridge approach.
      const connected = distance(road.points[0], plan) < 0.01 || distance(road.points.at(-1)!, plan) < 0.01
        || allPoints.filter(point => distance(point, road.points[0]) < 0.01).length > 1
        || road.template === 'bridge-approach';
      assert.ok(connected, road.id);
    }
    for (const house of plan.houses) {
      assert.ok(distance(house, plan) < plan.radius);
      assert.ok(plan.roads.some(road => road.id === `${house.id}:doorstep`));
      for (const other of plan.houses) if (house !== other) assert.ok(distance(house, other) > DEFAULT_CONFIG.population.houseWidth * (house.scale + other.scale) * 0.7);
    }
  }
  assert.ok(headings.size > 30); assert.ok(templates.has('left-bend') && templates.has('right-bend')); assert.ok(bends > 30);
  assert.equal(roadDistance(110, 130, DEFAULT_CONFIG), Infinity, 'Unsettled terrain has no infinite grid or riverside highway');
});

test('region cache eviction and different access orders preserve the entire settlement recipe', () => {
  const config = configSchema.parse({ population: { villageProbability: 0 } });
  const original = JSON.stringify(villagePlan(0, 0, config));
  for (let i = 1; i <= 200; i++) villagePlan(i, -i, config);
  assert.equal(JSON.stringify(villagePlan(0, 0, config)), original);
  for (const [rx, rz] of [[-2, 1], [1, -2], [0, 0]]) {
    assert.deepEqual(villagePlan(rx, rz, config), villagePlan(rx, rz, structuredClone(config)));
  }
});

test('shared settlement pieces and projected roads remain continuous across chunk boundaries', () => {
  const chunks = hexDisk({ q: 0, r: 1 }, 3).map(cell => generateChunk(cell, DEFAULT_CONFIG));
  const roads = new Map<string, string>(); let duplicates = 0, painted = 0;
  for (const chunk of chunks) {
    for (const road of chunk.roads) {
      const serialized = JSON.stringify(road);
      if (roads.has(road.id)) { assert.equal(roads.get(road.id), serialized); duplicates++; }
      roads.set(road.id, serialized);
    }
    const positions = projectRoads(chunk); assert.ok(positions.every(Number.isFinite)); painted += positions.length;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] + chunk.center.x, z = positions[i + 2] + chunk.center.z;
      const owner = hexKey(worldToHex(x, z, DEFAULT_CONFIG.chunkRadius));
      if (owner !== chunk.key) assert.ok(chunk.boundary.some(point => Math.hypot(point.x - positions[i], point.z - positions[i + 2]) < DEFAULT_CONFIG.chunkRadius / DEFAULT_CONFIG.subdivisions + 0.001));
    }
  }
  assert.ok(duplicates > 10); assert.ok(painted > 1000);
  const origin = villagePlan(0, 0, DEFAULT_CONFIG);
  for (const house of origin.houses) {
    assert.ok(villagesNear(house.x, house.z, 0, DEFAULT_CONFIG).some(plan => plan.id === origin.id));
    assert.ok(Number.isFinite(naturalTerrainHeight(house.x, house.z, DEFAULT_CONFIG)));
  }
});

import type { WorldConfig } from "../../protocol/src/config";
import { naturalTerrainHeight, riverCenter } from "./geography";
import { randomAt } from "./random";
import {
  distance,
  curvedStreet,
  groundPoint,
  onLand,
  roadDistanceTo,
  routeAccess,
  type RoadPath,
  type RoadPoint,
} from "./road-planning";
import { smoothRange } from "./spline";
import type { Point2 } from "./hex";

export interface HousePlan extends RoadPoint {
  id: string;
  scale: number;
  rotation: number;
  variant: number;
}
export interface BridgePlan extends RoadPoint {
  id: string;
}
export interface VillagePlan extends Point2 {
  id: string;
  region: { x: number; z: number };
  present: boolean;
  radius: number;
  roads: RoadPath[];
  houses: HousePlan[];
  bridges: BridgePlan[];
}
// Original connector grammar; weighted selection and bounded expansion follow jigsaw principles.
const STREET_POOL = [
  { name: "lane", weight: 4, turn: 0.08 },
  { name: "left-bend", weight: 3, turn: 0.8 },
  { name: "right-bend", weight: 3, turn: -0.8 },
  { name: "winding", weight: 2, turn: 1.2 },
] as const;
const caches = new WeakMap<WorldConfig, Map<string, VillagePlan>>();
export const villageRadius = (config: WorldConfig): number =>
  Math.min(
    config.population.villageRadius,
    config.population.villageSpacing * 0.28,
  );

function plotGrade(
  x: number,
  z: number,
  radius: number,
  config: WorldConfig,
): number {
  const heights = [-1, 1].flatMap((dx) =>
    [-1, 1].map((dz) =>
      naturalTerrainHeight(x + dx * radius, z + dz * radius, config),
    ),
  );
  return (Math.max(...heights) - Math.min(...heights)) / (radius * 2);
}

/** One candidate per jittered 2D region, chosen by land/slope suitability, not river distance. */
export function villagePlan(
  rx: number,
  rz: number,
  config: WorldConfig,
): VillagePlan {
  let cache = caches.get(config);
  if (!cache) {
    cache = new Map();
    caches.set(config, cache);
  }
  const key = `${rx},${rz}`,
    existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  const p = config.population,
    origin = rx === 0 && rz === 0;
  const random = (label: string, i = 0) =>
    randomAt(config.seed, `${key}:${label}`, i, 0);
  const startX = villageRadius(config) * 0.4;
  let center: Point2 = origin
      ? {
          x: startX,
          z: riverCenter(startX, config) + config.terrain.riverWidth * 3.2,
        }
      : { x: rx * p.villageSpacing, z: rz * p.villageSpacing },
    score = Infinity;
  for (let i = 0; !origin && i < 7; i++) {
    const candidate = {
      x: (rx + (random("center-x", i) - 0.5) * 0.28) * p.villageSpacing,
      z: (rz + (random("center-z", i) - 0.5) * 0.28) * p.villageSpacing,
    };
    if (!onLand(candidate, config)) continue;
    const grade = plotGrade(
      candidate.x,
      candidate.z,
      p.houseWidth * 1.5,
      config,
    );
    const value =
      grade * 5 +
      naturalTerrainHeight(candidate.x, candidate.z, config) /
        (config.terrain.snowLine * 3);
    if (grade < p.roadMaxSlope * 0.8 && value < score) {
      center = candidate;
      score = value;
    }
  }
  const present =
    origin ||
    (Number.isFinite(score) && random("presence") < p.villageProbability);
  const plan: VillagePlan = {
    id: `village:${key}`,
    region: { x: rx, z: rz },
    ...center,
    present,
    radius: villageRadius(config),
    roads: [],
    houses: [],
    bridges: [],
  };
  if (present) growVillage(plan, config, random, origin);
  // Eviction only affects performance. Rebuilding a plan uses the same coordinate-addressed seed.
  if (cache.size >= 192) cache.delete(cache.keys().next().value!);
  cache.set(key, plan);
  return plan;
}

function growVillage(
  plan: VillagePlan,
  config: WorldConfig,
  random: (label: string, i?: number) => number,
  origin: boolean,
): void {
  const p = config.population,
    roads = plan.roads;
  if (
    origin ||
    Math.abs(plan.z - riverCenter(plan.x, config)) < plan.radius * 0.9
  ) {
    const bx = origin
      ? 0
      : plan.x + (random("bridge-x") - 0.5) * plan.radius * 0.35;
    const bz = riverCenter(bx, config),
      side = plan.z > bz ? 1 : -1;
    const bank = { x: bx, z: bz + side * config.terrain.riverWidth * 1.2 };
    const access = routeAccess(bank, plan, config);
    if (origin || access)
      plan.bridges.push({
        id: `bridge:${plan.id}`,
        x: bx,
        z: bz,
        y: config.terrain.waterLevel + 1,
      });
    if (access) {
      roads.push({
        id: `${plan.id}:access`,
        points: access,
        width: p.roadWidth,
        depth: 0,
        template: "bridge-access",
      });
      const far = { x: bx, z: bz - side * config.terrain.riverWidth * 1.2 };
      const approach = curvedStreet(
        far,
        (-side * Math.PI) / 2,
        9,
        (random("approach") - 0.5) * 0.3,
        config,
      );
      if (approach)
        roads.push({
          id: `${plan.id}:approach`,
          points: approach,
          width: p.roadWidth,
          depth: 0,
          template: "bridge-approach",
        });
    }
  }
  const rootAngle = random("root-angle") * Math.PI * 2;
  const frontier = Array.from({ length: 3 }, (_, i) => ({
    start: groundPoint(plan, config),
    heading: rootAngle + (i * Math.PI * 2) / 3,
    depth: 1,
  }));
  const target =
    p.villageMinHouses +
    Math.floor(
      random("house-count") * (p.villageMaxHouses - p.villageMinHouses + 1),
    );
  let piece = 0;
  while (frontier.length && piece < Math.max(8, target + 2)) {
    const connector = frontier.shift()!,
      i = piece++;
    let selected: RoadPoint[] | undefined,
      heading = connector.heading,
      template = "";
    let lowestCost = Infinity;
    const pick =
      random("piece-pool", i) *
      STREET_POOL.reduce((sum, item) => sum + item.weight, 0);
    let cumulative = 0;
    const chosen = STREET_POOL.find(
      (item) => (cumulative += item.weight) > pick,
    )!;
    for (let attempt = 0; attempt < 7; attempt++) {
      const turn =
        (chosen.turn + (random(`turn-${i}`, attempt) - 0.5) * 0.7) *
        p.roadCurvature;
      const length = 15 + random(`length-${i}`, attempt) * 13;
      const angle =
        connector.heading +
        (attempt ? (attempt % 2 ? 1 : -1) * Math.ceil(attempt / 2) * 0.22 : 0);
      const points = curvedStreet(connector.start, angle, length, turn, config);
      if (
        !points ||
        points.some(
          (point) => distance(point, plan) > plan.radius - p.houseWidth * 1.3,
        )
      )
        continue;
      const end = points[points.length - 1];
      if (
        roads.some(
          (road) =>
            distance(road.points[0], connector.start) > 1 &&
            roadDistanceTo(end, road) < p.roadWidth * 1.8,
        )
      )
        continue;
      const cost =
        Math.abs(end.y - connector.start.y) +
        Math.abs(angle - connector.heading) * 0.4;
      if (cost < lowestCost) {
        lowestCost = cost;
        selected = points;
        heading = angle + turn;
        template = chosen.name;
      }
    }
    if (!selected) continue;
    roads.push({
      id: `${plan.id}:street:${i}`,
      points: selected,
      width: p.roadWidth * (0.85 + random("width", i) * 0.3),
      depth: connector.depth,
      template,
    });
    if (connector.depth >= p.roadDepth) continue;
    const end = selected[selected.length - 1];
    if (random("end", i) > 0.12)
      frontier.push({ start: end, heading, depth: connector.depth + 1 });
    if (random("fork", i) < p.roadBranching)
      frontier.push({
        start: end,
        heading:
          heading +
          (random("fork-side", i) > 0.5 ? 1 : -1) *
            (0.8 + random("fork-angle", i) * 0.6),
        depth: connector.depth + 1,
      });
  }
  const candidates = roads.flatMap((road) =>
    road.template === "bridge-approach"
      ? []
      : [0.4, 0.7, 0.95].flatMap((fraction) =>
          [-1, 1].map((side) => ({ road, fraction, side })),
        ),
  );
  candidates.sort(
    (a, b) =>
      random(`${a.road.id}:${a.fraction}:${a.side}`) -
      random(`${b.road.id}:${b.fraction}:${b.side}`),
  );
  for (const candidate of candidates) {
    if (plan.houses.length >= target) break;
    const { road, fraction, side } = candidate,
      i = plan.houses.length;
    const index = Math.max(1, Math.floor((road.points.length - 1) * fraction)),
      a = road.points[index - 1],
      b = road.points[index];
    const angle = Math.atan2(b.z - a.z, b.x - a.x),
      scale = 0.8 + random(`house-scale:${road.id}`, i) * 0.4;
    const setback = road.width / 2 + p.houseWidth * scale * 0.55 + 1.2;
    const x = b.x - Math.sin(angle) * setback * side,
      z = b.z + Math.cos(angle) * setback * side;
    const point = { x, z },
      radius = p.houseWidth * scale * 0.8;
    if (
      !onLand(point, config) ||
      distance(point, plan) + radius > plan.radius ||
      plotGrade(x, z, radius, config) > Math.min(0.38, p.roadMaxSlope * 0.9)
    )
      continue;
    if (
      Math.abs(z - riverCenter(x, config)) <
      config.terrain.riverWidth * 1.15 + radius
    )
      continue;
    if (
      plan.houses.some(
        (house) =>
          distance(house, point) <
          p.houseWidth * (house.scale + scale) * 0.78 + 1,
      )
    )
      continue;
    if (
      roads.some(
        (other) =>
          other !== road &&
          roadDistanceTo(point, other) < radius + other.width / 2 + 0.5,
      )
    )
      continue;
    const rotation = Math.atan2(b.x - x, b.z - z);
    const heights = [-1, 1].flatMap((dx) =>
      [-1, 1].map((dz) =>
        naturalTerrainHeight(
          x + (dx * p.houseWidth * scale) / 2,
          z + (dz * p.houseWidth * scale) / 2,
          config,
        ),
      ),
    );
    plan.houses.push({
      id: `${plan.id}:house:${i}`,
      x,
      z,
      y: heights.reduce((sum, value) => sum + value, 0) / heights.length,
      scale,
      rotation,
      variant: random("house-variant", i),
    });
  }
  // Each accepted door has an explicit connector to its street.
  for (const house of plan.houses) {
    let nearest: RoadPoint | undefined,
      nearestDistance = Infinity;
    for (const road of roads.filter((road) => road.template !== "doorstep"))
      for (const point of road.points) {
        const d = distance(house, point);
        if (d < nearestDistance) {
          nearestDistance = d;
          nearest = point;
        }
      }
    if (!nearest) continue;
    const halfDepth = p.houseWidth * house.scale * 0.42;
    const door = {
      x: house.x + Math.sin(house.rotation) * halfDepth,
      z: house.z + Math.cos(house.rotation) * halfDepth,
    };
    roads.push({
      id: `${house.id}:doorstep`,
      points: [nearest, { ...door, y: house.y }],
      width: Math.min(1.6, p.roadWidth * 0.5),
      depth: 0,
      template: "doorstep",
    });
  }
}

/** Fixed neighboring region bounds cover every piece, including across chunk boundaries. */
export function villagesNear(
  x: number,
  z: number,
  reach: number,
  config: WorldConfig,
): VillagePlan[] {
  const spacing = config.population.villageSpacing,
    radius = villageRadius(config),
    plans: VillagePlan[] = [];
  const padding = radius + spacing * 0.14 + reach;
  for (
    let rx = Math.ceil((x - padding) / spacing);
    rx <= Math.floor((x + padding) / spacing);
    rx++
  ) {
    for (
      let rz = Math.ceil((z - padding) / spacing);
      rz <= Math.floor((z + padding) / spacing);
      rz++
    ) {
      const plan = villagePlan(rx, rz, config);
      if (plan.present && distance(plan, { x, z }) <= radius + reach)
        plans.push(plan);
    }
  }
  const initial = villagePlan(0, 0, config);
  if (
    !plans.includes(initial) &&
    distance(initial, { x, z }) <= initial.radius + reach
  )
    plans.push(initial);
  return plans;
}

export function roadDistance(
  x: number,
  z: number,
  config: WorldConfig,
): number {
  let nearest = Infinity;
  for (const plan of villagesNear(x, z, config.population.roadWidth, config))
    for (const road of plan.roads)
      nearest = Math.min(nearest, roadDistanceTo({ x, z }, road));
  return nearest;
}

/** Local foundation collars, rather than flattening a whole village or river corridor. */
export function settlementTerrainHeight(
  x: number,
  z: number,
  height: number,
  config: WorldConfig,
): number {
  let weightedHeight = height,
    total = 1;
  const plans = villagesNear(x, z, config.population.foundationBlend, config);
  for (const plan of plans)
    for (const house of plan.houses) {
      const dx = x - house.x,
        dz = z - house.z,
        cos = Math.cos(house.rotation),
        sin = Math.sin(house.rotation);
      const localX = dx * cos - dz * sin,
        localZ = dx * sin + dz * cos;
      const half = (config.population.houseWidth * house.scale) / 2;
      const outside = Math.max(
        Math.abs(localX) - half - 1,
        Math.abs(localZ) - half * 0.84 - 1,
      );
      const weight =
        1 - smoothRange(0, config.population.foundationBlend, outside);
      if (weight >= 1) return house.y;
      const contribution = weight / (1 - weight);
      weightedHeight += house.y * contribution;
      total += contribution;
    }
  height = weightedHeight / total;
  // Keep the accepted street grade after foundation blending; only a narrow roadbed is adapted.
  let roadHeight = 0,
    roadWeights = 0,
    blend = 0;
  for (const plan of plans)
    for (const road of plan.roads) {
      let nearest = Infinity,
        projected = 0;
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1],
          b = road.points[i],
          dx = b.x - a.x,
          dz = b.z - a.z;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1),
          ),
        );
        const d = Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
        if (d < nearest) {
          nearest = d;
          projected = a.y + (b.y - a.y) * t;
        }
      }
      const weight =
        1 - smoothRange(road.width / 2, road.width / 2 + 2.5, nearest);
      const contribution = weight ** 4;
      roadHeight += projected * contribution;
      roadWeights += contribution;
      blend = Math.max(blend, weight);
    }
  return roadWeights
    ? height + (roadHeight / roadWeights - height) * blend
    : height;
}

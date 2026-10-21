import type { WorldConfig } from "../../protocol/src/config";
import { naturalTerrainHeight, riverCenter } from "./geography";
import { randomAt } from "./random";
import type { Point2 } from "./hex";

export interface RoadPoint extends Point2 {
  y: number;
}
export interface RoadPath {
  id: string;
  points: RoadPoint[];
  width: number;
  depth: number;
  template: string;
}
export const distance = (a: Point2, b: Point2): number =>
  Math.hypot(a.x - b.x, a.z - b.z);
export function segmentDistance(point: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x,
    dz = b.z - a.z;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz || 1),
    ),
  );
  return Math.hypot(point.x - a.x - t * dx, point.z - a.z - t * dz);
}
export const roadDistanceTo = (point: Point2, road: RoadPath): number => {
  let nearest = Infinity;
  for (let i = 1; i < road.points.length; i++)
    nearest = Math.min(
      nearest,
      segmentDistance(point, road.points[i - 1], road.points[i]),
    );
  return nearest;
};
export const onLand = (point: Point2, config: WorldConfig): boolean =>
  Math.abs(point.z - riverCenter(point.x, config)) >
    config.terrain.riverWidth * 1.02 &&
  naturalTerrainHeight(point.x, point.z, config) >
    config.terrain.waterLevel + 0.25;
export const groundPoint = (point: Point2, config: WorldConfig): RoadPoint => ({
  x: point.x,
  z: point.z,
  y: naturalTerrainHeight(point.x, point.z, config),
});

/** Finite, terrain-projected curve. Reject a piece if any sample is too steep or enters water. */
export function curvedStreet(
  start: Point2,
  heading: number,
  length: number,
  turn: number,
  config: WorldConfig,
): RoadPoint[] | undefined {
  const points: RoadPoint[] = [groundPoint(start, config)],
    steps = Math.max(4, Math.ceil(length / 3));
  for (let i = 1; i <= steps; i++) {
    const previous = points[points.length - 1],
      angle = heading + (turn * (i - 0.5)) / steps;
    const point = groundPoint(
      {
        x: previous.x + (Math.cos(angle) * length) / steps,
        z: previous.z + (Math.sin(angle) * length) / steps,
      },
      config,
    );
    if (
      !onLand(point, config) ||
      Math.abs(point.y - previous.y) / distance(point, previous) >
        config.population.roadMaxSlope
    )
      return;
    points.push(point);
  }
  return points;
}

/** Bounded A* builds an access connector to an actual bridge, not an infinite highway. */
export function routeAccess(
  start: Point2,
  end: Point2,
  config: WorldConfig,
): RoadPoint[] | undefined {
  const step = 5,
    padding = 25;
  const minX = Math.min(start.x, end.x) - padding,
    minZ = Math.min(start.z, end.z) - padding;
  const width = Math.ceil((Math.abs(end.x - start.x) + padding * 2) / step),
    depth = Math.ceil((Math.abs(end.z - start.z) + padding * 2) / step);
  type Node = {
    x: number;
    z: number;
    point: RoadPoint;
    score: number;
    cost: number;
    parent?: Node;
  };
  const cell = (p: Point2) => ({
    x: Math.round((p.x - minX) / step),
    z: Math.round((p.z - minZ) / step),
  });
  const first = cell(start),
    target = cell(end),
    visited = new Map<string, Node>(),
    open: Node[] = [];
  const initial: Node = {
    ...first,
    point: groundPoint(start, config),
    score: distance(start, end),
    cost: 0,
  };
  open.push(initial);
  visited.set(`${first.x},${first.z}`, initial);
  let expanded = 0;
  while (open.length && expanded++ < 2000) {
    open.sort((a, b) => a.score - b.score || a.x - b.x || a.z - b.z);
    const current = open.shift()!;
    if (current.x === target.x && current.z === target.z) {
      const path: RoadPoint[] = [groundPoint(end, config)];
      let node: Node | undefined = current;
      while (node) {
        path.push(node.point);
        node = node.parent;
      }
      const result = path
        .reverse()
        .filter((p, i, all) => !i || distance(p, all[i - 1]) > 0.01);
      if (
        result.some(
          (p, i) =>
            i &&
            Math.abs(p.y - result[i - 1].y) / distance(p, result[i - 1]) >
              config.population.roadMaxSlope,
        )
      )
        return;
      return result;
    }
    for (const dx of [-1, 0, 1])
      for (const dz of [-1, 0, 1]) {
        if (!dx && !dz) continue;
        const x = current.x + dx,
          z = current.z + dz;
        if (x < 0 || z < 0 || x > width || z > depth) continue;
        const point =
          x === target.x && z === target.z
            ? groundPoint(end, config)
            : groundPoint({ x: minX + x * step, z: minZ + z * step }, config);
        if (!onLand(point, config)) continue;
        const length = distance(current.point, point),
          grade = Math.abs(point.y - current.point.y) / Math.max(length, 0.01);
        if (grade > config.population.roadMaxSlope) continue;
        const cost =
          current.cost +
          length * (1 + grade * grade * 10) +
          randomAt(
            config.seed,
            "route-cost",
            Math.round(point.x),
            Math.round(point.z),
          ) *
            0.1;
        const key = `${x},${z}`,
          previous = visited.get(key);
        if (previous && previous.cost <= cost) continue;
        if (previous) {
          const index = open.indexOf(previous);
          if (index >= 0) open.splice(index, 1);
        }
        const next: Node = {
          x,
          z,
          point,
          cost,
          score: cost + distance(point, end),
          parent: current,
        };
        visited.set(key, next);
        open.push(next);
      }
  }
}

import type { WorldConfig } from "../../protocol/src/config";
import type { Hex } from "../../world/src/hex";
import { hexCenter, hexCorners, hexKey, worldToHex } from "../../world/src/hex";
import {
  generateChunkSurface,
  groundColor,
  type ChunkData,
} from "../../world/src/generator";
import { terrainHeight } from "../../world/src/terrain";
import { projectRoads } from "./road-geometry";
import { resolvePartMaterial } from "../../protocol/src/materials";
import { clipWaterTriangle } from "../../world/src/water";
import { columnBottom } from "../../world/src/surface";

export type OverviewLOD = "surface" | "detail";
export interface OverviewSummary {
  key: string;
  cell: Hex;
  center: { x: number; z: number };
  height: number;
  top: number;
  color: number[];
  corners: number[];
}
export interface OverviewMesh {
  key: string;
  lod: OverviewLOD;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
}
type V = { x: number; y: number; z: number };

export function overviewSummary(
  cell: Hex,
  config: WorldConfig,
): OverviewSummary {
  const center = hexCenter(cell, config.chunkRadius),
    height = terrainHeight(center.x, center.z, config);
  const corners = hexCorners(cell, config.chunkRadius).map((p) =>
    terrainHeight(p.x, p.z, config),
  );
  const top = Math.max(height, ...corners);
  return {
    key: hexKey(cell),
    cell,
    center,
    height,
    top,
    corners,
    color: groundColor(center.x, center.z, height, config),
  };
}

/** Visual-only LOD: fine terrain is unchanged; the surface fan keeps every authoritative boundary sample. */
export function buildOverviewMesh(
  cell: Hex,
  config: WorldConfig,
  lod: OverviewLOD,
  source?: ChunkData,
): OverviewMesh {
  const data = source ?? generateChunkSurface(cell, config, lod === "detail");
  const positions: number[] = [],
    colors: number[] = [],
    normals: number[] = [];
  const water: V[][] = [];
  const triangle = (a: V, b: V, c: V, color: number[]) => {
    const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const length = Math.hypot(nx, ny, nz) || 1;
    for (const v of [a, b, c]) {
      positions.push(v.x, v.y, v.z);
      colors.push(...color);
      normals.push(nx / length, ny / length, nz / length);
    }
  };
  const ground = (a: V, b: V, c: V, color: number[]) => {
    triangle(a, b, c, color);
    const clipped = clipWaterTriangle([a, b, c], config.terrain.waterLevel).map(
      (v) => ({ ...v, y: v.y + 0.03 }),
    );
    if (clipped.length > 2) water.push(clipped);
  };
  if (lod === "detail") {
    for (let i = 0; i < data.indices.length; i += 3) {
      const indices = Array.from(data.indices.slice(i, i + 3));
      const vertices = indices.map((j) => ({
        x: data.positions[j * 3],
        y: data.positions[j * 3 + 1],
        z: data.positions[j * 3 + 2],
      }));
      ground(
        vertices[0],
        vertices[1],
        vertices[2],
        [0, 1, 2].map(
          (channel) =>
            indices.reduce((sum, j) => sum + data.colors[j * 3 + channel], 0) /
            3,
        ),
      );
    }
    const roads = projectRoads(data);
    for (let i = 0; i < roads.length; i += 9) {
      const vertices = [0, 3, 6].map((j) => ({
        x: roads[i + j],
        y: roads[i + j + 1],
        z: roads[i + j + 2],
      }));
      triangle(vertices[0], vertices[1], vertices[2], [0.59, 0.47, 0.3]);
    }
  } else {
    const center = { x: 0, y: data.positions[1], z: 0 };
    for (let i = 0; i < data.boundary.length; i++) {
      const a = data.boundary[i],
        b = data.boundary[(i + 1) % data.boundary.length];
      ground(
        center,
        b,
        a,
        source
          ? Array.from(data.colors.slice(0, 3))
          : groundColor(
              data.center.x + (a.x + b.x) / 3,
              data.center.z + (a.z + b.z) / 3,
              (center.y + a.y + b.y) / 3,
              config,
            ),
      );
    }
  }
  const bottom = columnBottom(data, config.terrain.columnDepth);
  for (let i = 0; i < data.boundary.length; i++) {
    const a = data.boundary[i],
      b = data.boundary[(i + 1) % data.boundary.length];
    const bottomA = { ...a, y: bottom },
      bottomB = { ...b, y: bottom };
    triangle(a, b, bottomA, [0.27, 0.2, 0.12]);
    triangle(b, bottomB, bottomA, [0.27, 0.2, 0.12]);
  }
  for (const polygon of water)
    for (let i = 1; i < polygon.length - 1; i++)
      triangle(polygon[0], polygon[i], polygon[i + 1], [0.17, 0.42, 0.47]);
  const box = (
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    angle: number,
    color: number[],
  ) => {
    const vertices = [-1, 1].flatMap((dx) =>
      [0, 1].flatMap((dy) =>
        [-1, 1].map((dz) => {
          const px = (dx * width) / 2,
            pz = (dz * depth) / 2;
          return {
            x: x + Math.cos(angle) * px + Math.sin(angle) * pz,
            y: y + dy * height,
            z: z - Math.sin(angle) * px + Math.cos(angle) * pz,
          };
        }),
      ),
    );
    for (const [a, b, c] of [
      [0, 1, 2],
      [1, 3, 2],
      [4, 6, 5],
      [5, 6, 7],
      [0, 4, 1],
      [1, 4, 5],
      [2, 3, 6],
      [3, 7, 6],
      [0, 2, 4],
      [2, 6, 4],
      [1, 5, 3],
      [3, 5, 7],
    ])
      triangle(vertices[a], vertices[b], vertices[c], color);
  };
  for (const asset of data.assets) {
    if (lod !== "detail" && asset.role !== "building") continue;
    if (hexKey(worldToHex(asset.x, asset.z, config.chunkRadius)) !== data.key)
      continue;
    const x = asset.x - data.center.x,
      z = asset.z - data.center.z,
      y = asset.y;
    if (asset.design) {
      if (lod !== "detail") {
        const low = [0, 1, 2].map(
          (axis) =>
            Math.min(
              ...asset.design!.parts.map(
                (p) => p.position[axis] - p.size[axis] / 2,
              ),
            ) * asset.scale,
        );
        const high = [0, 1, 2].map(
          (axis) =>
            Math.max(
              ...asset.design!.parts.map(
                (p) => p.position[axis] + p.size[axis] / 2,
              ),
            ) * asset.scale,
        );
        const px = (low[0] + high[0]) / 2,
          pz = (low[2] + high[2]) / 2;
        box(
          x + Math.cos(asset.rotation) * px + Math.sin(asset.rotation) * pz,
          y + low[1],
          z - Math.sin(asset.rotation) * px + Math.cos(asset.rotation) * pz,
          high[0] - low[0],
          high[1] - low[1],
          high[2] - low[2],
          asset.rotation,
          [0.35, 0.44, 0.52],
        );
        continue;
      }
      for (const p of asset.design.parts) {
        const color = resolvePartMaterial(asset.design, p)
          .color.match(/\w\w/g)!
          .map((v) => Math.pow(parseInt(v, 16) / 255, 2.2));
        const px = p.position[0] * asset.scale,
          pz = p.position[2] * asset.scale;
        box(
          x + Math.cos(asset.rotation) * px + Math.sin(asset.rotation) * pz,
          y + (p.position[1] - p.size[1] / 2) * asset.scale,
          z - Math.sin(asset.rotation) * px + Math.cos(asset.rotation) * pz,
          p.size[0] * asset.scale,
          p.size[1] * asset.scale,
          p.size[2] * asset.scale,
          asset.rotation,
          color,
        );
      }
    } else if (asset.kind === "house") {
      const width = config.population.houseWidth * asset.scale,
        height = config.population.houseHeight * asset.scale;
      box(
        x,
        y,
        z,
        width,
        height * 0.65,
        width * 0.84,
        asset.rotation,
        [0.73, 0.67, 0.49],
      );
      box(
        x,
        y + height * 0.65,
        z,
        width * 1.1,
        height * 0.15,
        width * 0.95,
        asset.rotation,
        asset.variant > 0.5 ? [0.42, 0.19, 0.12] : [0.24, 0.23, 0.17],
      );
    } else if (asset.kind === "bridge")
      box(
        x,
        y - 0.3,
        z,
        config.population.bridgeWidth,
        0.3,
        config.terrain.riverWidth * 2.3,
        0,
        [0.39, 0.26, 0.15],
      );
    else {
      const tree = asset.kind === "pine" || asset.kind === "birch";
      const height = (tree ? config.population.treeHeight : 1.2) * asset.scale;
      if (tree)
        box(
          x,
          y,
          z,
          height * 0.08,
          height * 0.55,
          height * 0.08,
          0,
          [0.27, 0.2, 0.12],
        );
      const top = { x, y: y + height, z },
        bottom = y + (tree ? height * 0.35 : 0),
        radius = height * (tree ? 0.3 : 0.65);
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3,
          b = ((i + 1) * Math.PI) / 3;
        triangle(
          top,
          {
            x: x + Math.cos(a) * radius,
            y: bottom,
            z: z + Math.sin(a) * radius,
          },
          {
            x: x + Math.cos(b) * radius,
            y: bottom,
            z: z + Math.sin(b) * radius,
          },
          asset.kind === "rock"
            ? [0.35, 0.37, 0.31]
            : asset.kind === "pine"
              ? [0.06, 0.2, 0.12]
              : [0.23, 0.38, 0.12],
        );
      }
    }
  }
  return {
    key: data.key,
    lod,
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    normals: new Float32Array(normals),
  };
}

/** Resource ownership and eviction are explicit; exploration metadata is never evicted here. */
export class ByteCache<T> {
  readonly entries = new Map<string, { value: T; bytes: number }>();
  bytes = 0;
  hits = 0;
  constructor(
    public limit: number,
    private dispose: (value: T) => void,
  ) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, bytes: number): void {
    this.delete(key);
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    this.trim();
  }
  trim(): void {
    while (this.bytes > this.limit && this.entries.size)
      this.delete(this.entries.keys().next().value!);
  }
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.entries.delete(key);
      this.dispose(entry.value);
    }
  }
  clear(): void {
    for (const key of this.entries.keys()) this.delete(key);
  }
}

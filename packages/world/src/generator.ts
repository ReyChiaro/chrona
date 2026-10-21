import {
  GENERATOR_VERSION,
  PALETTE,
  type WorldConfig,
} from "../../protocol/src/config";
import { hexCenter, hexCorners, hexKey, snap, type Hex } from "./hex";
import { hashString, randomAt } from "./random";
import {
  biomeAt,
  riverCenter,
  roadDistance,
  terrainHeight,
  type Biome,
} from "./terrain";
import { villagesNear } from "./settlements";
import { roadDistanceTo, type RoadPath } from "./road-planning";
import type { AssetRecipe } from "../../protocol/src/content";

export interface Asset {
  id: string;
  kind: "pine" | "birch" | "shrub" | "house" | "bridge" | "rock" | "custom";
  x: number;
  y: number;
  z: number;
  scale: number;
  rotation: number;
  variant: number;
  design?: AssetRecipe;
  contentKey?: string;
  role?: "building" | "prop" | "vehicle";
}
export interface ChunkData {
  cell: Hex;
  key: string;
  center: { x: number; z: number };
  biome: Biome;
  positions: Float32Array;
  indices: Uint32Array;
  colors: Float32Array;
  boundary: { x: number; y: number; z: number }[];
  assets: Asset[];
  roads: RoadPath[];
  fingerprint: string;
  contentPackages?: string[];
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  const srgb = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  return srgb.map((c) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4),
  ) as [number, number, number];
}

export function groundColor(
  x: number,
  z: number,
  height: number,
  config: WorldConfig,
): [number, number, number] {
  const distance = Math.abs(z - riverCenter(x, config));
  const biome = biomeAt(x, z, config, height);
  let color: string = PALETTE.grass;
  if (distance < config.terrain.riverWidth * 0.9) color = PALETTE.sand;
  else if (roadDistance(x, z, config) < config.population.roadWidth * 0.55)
    color = PALETTE.road;
  else if (height > config.terrain.snowLine) color = PALETTE.snow;
  else if (height > config.terrain.snowLine * 0.62) color = PALETTE.rock;
  else if (height > config.terrain.elevation * 0.8) color = PALETTE.hill;
  else if (biome === "forest") color = PALETTE.forest;
  else if (biome === "meadow") color = PALETTE.meadow;
  const base = rgb(color);
  const shade =
    0.93 +
    randomAt(
      config.seed,
      "ground-color",
      Math.round(x / 3),
      Math.round(z / 3),
    ) *
      0.14;
  return base.map((c) => Math.min(1, c * shade)) as [number, number, number];
}

export function generateChunk(cell: Hex, config: WorldConfig): ChunkData {
  return generateChunkSurface(cell, config);
}

/** Presentation callers may omit assets without touching authoritative generation records. */
export function generateChunkSurface(
  cell: Hex,
  config: WorldConfig,
  includeAssets = true,
): ChunkData {
  const center = hexCenter(cell, config.chunkRadius);
  const corners = hexCorners(cell, config.chunkRadius);
  const positions: number[] = [],
    colors: number[] = [],
    indices: number[] = [];
  const boundary: ChunkData["boundary"] = [];
  const n = config.subdivisions;
  for (let side = 0; side < 6; side++) {
    const a = corners[side],
      b = corners[(side + 1) % 6];
    const rows: number[][] = [];
    for (let i = 0; i <= n; i++) {
      rows[i] = [];
      for (let j = 0; j <= n - i; j++) {
        const x = snap(
          center.x + ((a.x - center.x) * i) / n + ((b.x - center.x) * j) / n,
        );
        const z = snap(
          center.z + ((a.z - center.z) * i) / n + ((b.z - center.z) * j) / n,
        );
        const y = terrainHeight(x, z, config);
        rows[i][j] = positions.length / 3;
        positions.push(x - center.x, y, z - center.z);
        colors.push(...groundColor(x, z, y, config));
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        // Reversed XZ winding gives upward-facing triangle normals.
        indices.push(rows[i][j], rows[i][j + 1], rows[i + 1][j]);
        if (j < n - i - 1)
          indices.push(rows[i + 1][j], rows[i][j + 1], rows[i + 1][j + 1]);
      }
    }
    for (let i = 0; i < n; i++) {
      const x = snap(a.x + ((b.x - a.x) * i) / n),
        z = snap(a.z + ((b.z - a.z) * i) / n);
      boundary.push({
        x: x - center.x,
        y: terrainHeight(x, z, config),
        z: z - center.z,
      });
    }
  }
  const assets = includeAssets ? generateAssets(cell, config) : [];
  const roads = villagesNear(center.x, center.z, config.chunkRadius, config)
    .flatMap((plan) => plan.roads)
    .filter(
      (road) => roadDistanceTo(center, road) <= config.chunkRadius + road.width,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  const data = {
    cell,
    key: hexKey(cell),
    center,
    biome: biomeAt(center.x, center.z, config),
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    colors: new Float32Array(colors),
    boundary,
    assets,
    roads,
  };
  const canonical = includeAssets
    ? JSON.stringify({
        generator: GENERATOR_VERSION,
        seed: config.seed,
        cell,
        heights: positions.map((v) => Math.round(v * 1e5)),
        assets,
        roads,
      })
    : "";
  return {
    ...data,
    fingerprint: includeAssets
      ? hashString(canonical).toString(16).padStart(8, "0")
      : "",
  };
}

/** Shared global candidates and stable identities avoid duplicates at cell boundaries. */
function generateAssets(cell: Hex, config: WorldConfig): Asset[] {
  const center = hexCenter(cell, config.chunkRadius);
  const reach = config.chunkRadius;
  const assets: Asset[] = [];
  const intersects = (x: number, z: number, radius: number) =>
    Math.hypot(x - center.x, z - center.z) < reach + radius;
  const spacing = config.population.treeSpacing;
  const padding = config.population.treeHeight * 0.6;
  const villages = villagesNear(
    center.x,
    center.z,
    reach + config.population.houseWidth,
    config,
  );
  for (
    let ix = Math.floor((center.x - reach - padding) / spacing);
    ix <= Math.ceil((center.x + reach + padding) / spacing);
    ix++
  ) {
    for (
      let iz = Math.floor((center.z - reach - padding) / spacing);
      iz <= Math.ceil((center.z + reach + padding) / spacing);
      iz++
    ) {
      const chance = randomAt(config.seed, "tree-presence", ix, iz);
      const x =
        (ix + 0.2 + randomAt(config.seed, "tree-x", ix, iz) * 0.6) * spacing;
      const z =
        (iz + 0.2 + randomAt(config.seed, "tree-z", ix, iz) * 0.6) * spacing;
      const waterDistance = Math.abs(z - riverCenter(x, config));
      const road = roadDistance(x, z, config);
      if (
        waterDistance < config.terrain.riverWidth * 1.2 ||
        road < config.population.roadWidth * 0.85 ||
        !intersects(x, z, padding)
      )
        continue;
      if (
        villages.some((village) =>
          village.houses.some(
            (house) =>
              Math.hypot(x - house.x, z - house.z) <
              config.population.houseWidth * house.scale * 0.9,
          ),
        )
      )
        continue;
      const height = terrainHeight(x, z, config);
      const biome = biomeAt(x, z, config, height);
      const scale = 0.7 + randomAt(config.seed, "tree-scale", ix, iz) * 0.6;
      const wooded =
        height < config.terrain.snowLine * 0.85 &&
        chance <
          config.population.treeDensity * (biome === "meadow" ? 0.16 : 0.55);
      const kind = wooded
        ? randomAt(config.seed, "tree-species", ix, iz) > 0.6
          ? "birch"
          : "pine"
        : height > config.terrain.snowLine * 0.75 && chance < 0.2
          ? "rock"
          : chance < config.population.shrubDensity
            ? "shrub"
            : undefined;
      if (kind)
        assets.push({
          id: `${kind}:${ix}:${iz}`,
          kind,
          x,
          z,
          y: height,
          scale,
          rotation: chance * Math.PI * 2,
          variant: chance,
        });
    }
  }
  for (const village of villages) {
    for (const bridge of village.bridges)
      if (intersects(bridge.x, bridge.z, config.terrain.riverWidth * 1.3)) {
        assets.push({
          ...bridge,
          kind: "bridge",
          scale: 1,
          rotation: 0,
          variant: 0,
        });
      }
    for (const house of village.houses) {
      if (intersects(house.x, house.z, config.population.houseWidth))
        assets.push({ ...house, kind: "house" });
    }
  }
  return assets.sort((a, b) => a.id.localeCompare(b.id));
}

export function boundarySamples(
  cell: Hex,
  config: WorldConfig,
): { x: number; y: number; z: number }[] {
  const data = generateChunk(cell, config);
  return data.boundary.map((p) => ({
    x: snap(p.x + data.center.x),
    y: p.y,
    z: snap(p.z + data.center.z),
  }));
}

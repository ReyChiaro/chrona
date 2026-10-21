import { LocalizedError } from '../../i18n/src/index';
import { msg } from '../../i18n/src/index';
import type { ContentPackage } from '../../protocol/src/content';
import type { RegionDeployment, RegionRecipe } from '../../protocol/src/regions';
import type { WorldConfig } from '../../protocol/src/config';
import { hexCenter, hexCorners, hexDisk, hexKey, worldToHex, type Hex } from './hex';
import { terrainHeight, riverCenter, roadDistance } from './terrain';
import { randomAt } from './random';
import { segmentDistance, type RoadPath } from './road-planning';
import type { Asset, ChunkData } from './generator';
import { surfaceHeight } from './surface';

export const smooth = (v: number): number => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
export const regionKey = (pack: ContentPackage): string => `${pack.id}@${pack.version}`;
export function regionCells(region: RegionRecipe, config: WorldConfig): Hex[] {
  return hexDisk(worldToHex(region.center.x, region.center.z, config.chunkRadius), Math.ceil(region.radius / (config.chunkRadius * 1.5)) + 3)
    .filter(cell => { const p = hexCenter(cell, config.chunkRadius); return Math.hypot(p.x - region.center.x, p.z - region.center.z) < region.radius + config.chunkRadius; });
}
function distanceToHex(x: number, z: number, cell: Hex, radius: number): number {
  const points = hexCorners(cell, radius), p = { x, z };
  let sign = 0, inside = true, distance = Infinity;
  for (let i = 0; i < 6; i++) {
    const a = points[i], b = points[(i + 1) % 6], cross = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x);
    if (Math.abs(cross) > 1e-6) { if (sign && Math.sign(cross) !== sign) inside = false; sign = Math.sign(cross); }
    distance = Math.min(distance, segmentDistance(p, a, b));
  }
  return inside ? 0 : distance;
}
export function regionWeight(region: RegionRecipe, x: number, z: number, protectedCells: Hex[], config: WorldConfig): number {
  let weight = smooth((region.radius - Math.hypot(x - region.center.x, z - region.center.z)) / region.transition);
  for (const cell of protectedCells) weight = Math.min(weight, smooth(distanceToHex(x, z, cell, config.chunkRadius) / (config.chunkRadius * 1.25)));
  return weight;
}
/** Absolute target surfaces replace the previous surface; operators are authored independently of chunks. */
export function regionHeight(region: RegionRecipe, x: number, z: number): number {
  const lx = x - region.center.x, lz = z - region.center.z;
  let height = region.elevation;
  for (const op of region.operators) {
    const dx = lx - op.offset.x, dz = lz - op.offset.z, r = Math.hypot(dx, dz);
    if (op.kind === 'ridge') {
      const u = dx * Math.cos(op.angle) + dz * Math.sin(op.angle);
      height += op.height * Math.pow(0.5 + 0.5 * Math.cos(u / op.wavelength * Math.PI * 2), 2);
    } else if (op.kind === 'terrace') height += op.height * (1 - smooth(r / op.radius));
    else {
      // Continuous cone with a raised crater rim and depressed centre, not sinusoidal noise.
      const rim = op.craterRadius;
      const cone = op.height * (1 - smooth(Math.max(0, r - rim) / (op.radius - rim)));
      height += cone - op.craterDepth * (1 - smooth(r / rim));
    }
  }
  return height;
}
export function nearbyProtected(deployment: RegionDeployment | undefined, cell: Hex): Hex[] {
  if (!deployment) return [];
  const keys = new Set(deployment.protectedChunks);
  return hexDisk(cell, 3).filter(p => keys.has(hexKey(p)));
}
export function regionRoads(pack: ContentPackage): RoadPath[] {
  const r = pack.region!;
  return r.roads.map(road => {
    const points = road.points.map(p => ({ x: r.center.x + p.x, z: r.center.z + p.z, y: regionHeight(r, r.center.x + p.x, r.center.z + p.z) }));
    if (road.closed) points.push({ ...points[0] });
    return { id: `${regionKey(pack)}:road:${road.id}`, points, width: road.width, depth: 0, template: 'regional-asphalt' };
  });
}
export function placementAsset(pack: ContentPackage, placement: RegionRecipe['placements'][number]): Asset {
  const r = pack.region!, x = r.center.x + placement.position.x, z = r.center.z + placement.position.z;
  return { id: `${regionKey(pack)}:object:${placement.id}`, kind: 'custom', x, y: regionHeight(r, x, z), z, scale: placement.scale,
    rotation: placement.rotation, variant: 0, design: pack.assets[placement.asset], contentKey: regionKey(pack), role: placement.role };
}
export function regionSurface(region: RegionRecipe, x: number, z: number): number[] {
  const volcanic = region.operators.find(op => op.kind === 'volcano');
  const rock = volcanic && Math.hypot(x - region.center.x - volcanic.offset.x, z - region.center.z - volcanic.offset.z) < volcanic.craterRadius;
  const color = rock && region.surface.rockColor ? region.surface.rockColor : region.surface.color;
  return color.match(/\w\w/g)!.map(v => { const c = parseInt(v, 16) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
}
/** Authored layouts reserve their space before vegetation and decorative scatter. */
export function applyRegion(chunk: ChunkData, pack: ContentPackage, deployment: RegionDeployment | undefined, config: WorldConfig): void {
  const r = pack.region!, protectedCells = nearbyProtected(deployment, chunk.cell);
  const originalRoads = [...chunk.roads], originalHouses = chunk.assets.filter(a => a.kind === 'house' || a.kind === 'bridge');
  const weight = (x: number, z: number) => {
    let w = regionWeight(r, x, z, protectedCells, config);
    if (r.preserveCorridors) {
      w *= smooth((Math.abs(z - riverCenter(x, config)) - config.terrain.riverWidth * 1.7) / 10);
      for (const road of originalRoads) for (let i = 1; i < road.points.length; i++) w *= smooth((segmentDistance({ x, z }, road.points[i - 1], road.points[i]) - road.width * 1.5) / 8);
    }
    if (!r.clearing.settlements) for (const house of originalHouses) w *= smooth((Math.hypot(x - house.x, z - house.z) - config.population.houseWidth * 1.3) / 8);
    return w;
  };
  if (Math.hypot(chunk.center.x - r.center.x, chunk.center.z - r.center.z) > r.radius + config.chunkRadius) return;
  const sample = (x: number, z: number, base: number) => {
    const w = weight(x, z); return base * (1 - w) + regionHeight(r, x, z) * w;
  };
  for (let i = 0; i < chunk.positions.length; i += 3) {
    const x = chunk.center.x + chunk.positions[i], z = chunk.center.z + chunk.positions[i + 2], w = weight(x, z);
    chunk.positions[i + 1] = sample(x, z, chunk.positions[i + 1]);
    const color = r.water && chunk.positions[i + 1] >= config.terrain.waterLevel && chunk.positions[i + 1] <= config.terrain.waterLevel + r.water.shoreHeight
      ? r.water.shoreColor.match(/\w\w/g)!.map(v => { const c = parseInt(v, 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
      : regionSurface(r, x, z);
    for (let j = 0; j < 3; j++) chunk.colors[i + j] = chunk.colors[i + j] * (1 - w) + color[j] * w;
  }
  for (const p of chunk.boundary) p.y = sample(chunk.center.x + p.x, chunk.center.z + p.z, p.y);
  chunk.assets = chunk.assets.filter(a => {
    if (weight(a.x, a.z) < 0.8) return true;
    return !((r.clearing.vegetation && ['pine', 'birch', 'shrub'].includes(a.kind)) || (r.clearing.rocks && a.kind === 'rock') || (r.clearing.settlements && ['house', 'bridge', 'custom'].includes(a.kind)));
  });
  if (r.clearing.settlements) chunk.roads = chunk.roads.filter(road => road.points.some(p => weight(p.x, p.z) < 0.8));
  const roads = regionRoads(pack);
  chunk.roads.push(...roads.filter(road => road.points.some((p, i) => i && segmentDistance(chunk.center, road.points[i - 1], p) < config.chunkRadius + road.width)));
  for (const placement of r.placements) {
    const a = placementAsset(pack, placement);
    if (hexKey(worldToHex(a.x, a.z, config.chunkRadius)) !== chunk.key || weight(a.x, a.z) < 0.98) continue;
    a.y = surfaceHeight(chunk, a.x, a.z) ?? a.y;
    if (!matchesHabitat(a, placement.habitat, config.terrain.waterLevel)) continue;
    chunk.assets.push(a);
  }
  for (const scatter of r.scatter) for (let i = 0; i < scatter.count; i++) {
    const angle = randomAt(config.seed, `${regionKey(pack)}:${scatter.asset}`, i, 0) * Math.PI * 2;
    const distance = Math.sqrt(randomAt(config.seed, `${regionKey(pack)}:${scatter.asset}`, i, 1)) * (r.radius - r.transition);
    const x = r.center.x + Math.cos(angle) * distance, z = r.center.z + Math.sin(angle) * distance;
    if (hexKey(worldToHex(x, z, config.chunkRadius)) !== chunk.key || weight(x, z) < 0.98) continue;
    if (roads.some(road => road.points.some((p, j) => j && segmentDistance({ x, z }, road.points[j - 1], p) < road.width / 2 + scatter.clearance))) continue;
    if (chunk.assets.some(a => Math.hypot(a.x - x, a.z - z) < scatter.clearance + (a.role === 'building' ? 10 : 2))) continue;
    const asset: Asset = { id: `${regionKey(pack)}:scatter:${scatter.asset}:${i}`, kind: 'custom', x, y: surfaceHeight(chunk, x, z) ?? regionHeight(r, x, z), z, scale: 1,
      rotation: angle, variant: 0, design: pack.assets[scatter.asset], contentKey: regionKey(pack), role: 'prop' };
    if (matchesHabitat(asset, scatter.habitat, config.terrain.waterLevel)) chunk.assets.push(asset);
  }
  for (const a of chunk.assets) if (a.contentKey !== regionKey(pack) && a.role !== 'building' && !['house', 'bridge'].includes(a.kind) && weight(a.x, a.z) > 0)
    a.y = surfaceHeight(chunk, a.x, a.z) ?? a.y;
  if (weight(chunk.center.x, chunk.center.z) > 0.5) chunk.biome = r.operators.some(op => op.kind === 'volcano') ? 'volcanic' : r.roads.length && r.placements.some(p => p.role === 'building') ? 'urban' : r.surface.snowCover ? 'snowfield' : chunk.biome;
  if (r.water && weight(chunk.center.x, chunk.center.z) > 0.5 && chunk.positions[1] < config.terrain.waterLevel) chunk.biome = r.water.kind;
}

export function matchesHabitat(asset: Asset, habitat: 'land' | 'underwater' | undefined, level: number): boolean {
  if (!habitat) return true;
  if (habitat === 'land') return asset.y >= level;
  const top = Math.max(...asset.design!.parts.map(p => p.position[1] + p.size[1] / 2)) * asset.scale;
  return asset.y + top < level - 0.1;
}

export function suggestRegionSite(config: WorldConfig, camera: { x: number; z: number; yaw: number }, explored: Iterable<Hex>, radius = 120) {
  const old = [...explored].map(c => hexCenter(c, config.chunkRadius));
  for (let step = 0; step < 30; step++) {
    const distance = radius + config.chunkRadius * 3 + step * config.chunkRadius * 2;
    const center = { x: Math.round(camera.x - Math.sin(camera.yaw) * distance), z: Math.round(camera.z - Math.cos(camera.yaw) * distance) };
    if (old.every(p => Math.hypot(center.x - p.x, center.z - p.z) > radius + config.chunkRadius * 2))
      return { center, radius, transition: 28, elevation: Math.max(config.terrain.waterLevel + 8, Math.round(terrainHeight(center.x, center.z, config))), direction: 'ahead', protectedChunkCount: old.length,
        corridors: { roadDistance: Math.round(roadDistance(center.x, center.z, config)), riverDistance: Math.round(Math.abs(center.z - riverCenter(center.x, config))) } };
  }
  throw new LocalizedError('world.regions.not-enough-unexplored-space-ahead-turn-and-try-generating');
}

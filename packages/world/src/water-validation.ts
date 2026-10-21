import type { ContentPackage } from '../../protocol/src/content';
import type { WorldConfig } from '../../protocol/src/config';
import type { WaterReport } from '../../protocol/src/regions';
import type { ChunkData, Asset } from './generator';
import { nearbyProtected, regionWeight } from './regions';
import type { RegionDeployment } from '../../protocol/src/regions';
import { clipWaterTriangle, polygonArea } from './water';
import { resolvePartMaterial } from '../../protocol/src/materials';

export const requestsWater = (prompt: string): boolean => /海洋|海域|大海|海岸|海湾|湖泊|\bocean\b|\bsea\b|\bcoast(?:line)?\b|\blake\b/i.test(prompt.replace(/海洋(?:蓝色?|风格|主题)|\b(?:ocean|sea)[ -](?:blue|themed)\b/gi, ''))
  && !/摆件|雕塑|微缩|miniature|sculpture/i.test(prompt);

/** Reject the old workaround explicitly; adding more ground-anchored water tiles cannot repair it. */
export function waterTileAssets(pack: ContentPackage): string[] {
  return Object.entries(pack.assets).filter(([id, design]) => /海水|海面|水面|water|ocean|sea-/i.test(id + design.label)
    && design.parts.some(p => p.shape === 'box' && Math.min(p.size[0], p.size[2]) >= 8 && p.size[1] < Math.min(p.size[0], p.size[2]) * 0.1
      && (resolvePartMaterial(design, p).opacity ?? 1) < 1)).map(([id]) => id);
}

/** Measure exactly the same clipped native water polygons rendered in all three views. */
export function measureRegionWater(pack: ContentPackage, chunks: Iterable<ChunkData>, assets: Iterable<Asset>, config: WorldConfig, deployment?: RegionDeployment): WaterReport {
  const r = pack.region!, level = config.terrain.waterLevel;
  let area = 0, maxDepth = 0, shoreline = 0, beachArea = 0;
  const parents: number[] = [], areas: number[] = [], vertices = new Map<string, number>();
  const root = (index: number): number => { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; };
  for (const chunk of chunks) {
    const protectedCells = nearbyProtected(deployment, chunk.cell);
    for (let i = 0; i < chunk.indices.length; i += 3) {
      const triangle = Array.from(chunk.indices.slice(i, i + 3)).map(j => ({ x: chunk.positions[j * 3], y: chunk.positions[j * 3 + 1], z: chunk.positions[j * 3 + 2] }));
      const centerX = chunk.center.x + triangle.reduce((s, p) => s + p.x, 0) / 3, centerZ = chunk.center.z + triangle.reduce((s, p) => s + p.z, 0) / 3;
      if (regionWeight(r, centerX, centerZ, protectedCells, config) < 0.98) continue;
      const polygon = clipWaterTriangle(triangle, level), wetArea = polygonArea(polygon);
      beachArea += Math.max(0, polygonArea(clipWaterTriangle(triangle, level + (r.water?.shoreHeight ?? 1.2))) - wetArea);
      if (wetArea < 1e-6) continue;
      area += wetArea; maxDepth = Math.max(maxDepth, ...triangle.map(p => level - p.y));
      const index = parents.length; parents.push(index); areas.push(wetArea);
      for (const p of polygon) {
        const key = `${Math.round((chunk.center.x + p.x) * 1000)},${Math.round((chunk.center.z + p.z) * 1000)}`;
        const neighbor = vertices.get(key);
        if (neighbor !== undefined) parents[root(index)] = root(neighbor); else vertices.set(key, index);
      }
      const intersections = [];
      for (let j = 0; j < 3; j++) {
        const a = triangle[j], b = triangle[(j + 1) % 3];
        if ((a.y <= level) !== (b.y <= level)) { const t = (level - a.y) / (b.y - a.y); intersections.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); }
      }
      if (intersections.length === 2) shoreline += Math.hypot(intersections[0].x - intersections[1].x, intersections[0].z - intersections[1].z);
    }
  }
  const components = new Map<number, number>();
  parents.forEach((_, i) => components.set(root(i), (components.get(root(i)) ?? 0) + areas[i]));
  const largest = Math.max(0, ...components.values());
  const submerged = [...assets].filter(a => {
    const placement = r.placements.find(p => a.id.endsWith(`:object:${p.id}`));
    const scatter = r.scatter.find(s => a.id.includes(`:scatter:${s.asset}:`));
    return (placement?.habitat ?? scatter?.habitat) === 'underwater';
  });
  return { level, area, maxDepth, shoreline, beachArea, components: [...components.values()].filter(a => a >= Math.max(10, largest * 0.02)).length,
    largestComponentRatio: area ? largest / area : 0, submergedPlants: submerged.length };
}

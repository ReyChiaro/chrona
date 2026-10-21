import type { ContentPackage } from '../../protocol/src/content';
import type { WorldConfig } from '../../protocol/src/config';
import type { RegionRecipe } from '../../protocol/src/regions';
import { hexKey, worldToHex } from './hex';
import type { Asset, ChunkData } from './generator';
import { regionKey, regionRoads } from './regions';
/** Analytic road following uses absolute world time, including time spent outside loaded chunks. */
export function vehiclePose(pack: ContentPackage, vehicle: RegionRecipe['vehicles'][number], seconds: number): Asset {
  const road = regionRoads(pack).find(r => r.id.endsWith(`:road:${vehicle.road}`))!;
  const lengths = road.points.slice(1).map((p, i) => Math.hypot(p.x - road.points[i].x, p.z - road.points[i].z));
  const length = lengths.reduce((a, b) => a + b, 0);
  let distance = ((seconds * vehicle.speed + vehicle.phase * length) % length + length) % length;
  let i = 0; while (i < lengths.length - 1 && distance > lengths[i]) distance -= lengths[i++];
  const a = road.points[i], b = road.points[i + 1], t = distance / Math.max(lengths[i], 1e-6);
  return { id: `${regionKey(pack)}:vehicle:${vehicle.id}`, kind: 'custom', x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + 0.06,
    z: a.z + (b.z - a.z) * t, rotation: Math.atan2(-(b.x - a.x), -(b.z - a.z)), scale: 1, variant: 0,
    design: pack.assets[vehicle.asset], contentKey: regionKey(pack), role: 'vehicle' };
}


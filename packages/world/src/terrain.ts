import { msg } from '../../i18n/src/index';
import type { WorldConfig } from '../../protocol/src/config';
import { surfaceClimate } from './landforms';
import { naturalTerrainHeight, riverCenter } from './geography';
import { settlementTerrainHeight, villagesNear } from './settlements';
export { riverCenter } from './geography';
export { roadDistance } from './settlements';

export type Biome = 'valley' | 'forest' | 'village' | 'river' | 'highland' | 'meadow' | 'mountain' | 'snowfield' | 'volcanic' | 'urban' | 'ocean' | 'lake';
export const BIOME_LABELS: Record<Biome, string> = {
  valley: msg('world.terrain.valley'), forest: msg('world.terrain.forest'), village: msg('world.terrain.village'), river: msg('world.terrain.river'), highland: msg('world.terrain.mountains'), meadow: msg('world.terrain.meadow'), mountain: msg('world.terrain.alpine'),
  snowfield: msg('world.terrain.snowy-mountains'), volcanic: msg('world.terrain.volcano'), urban: msg('world.terrain.city'), ocean: msg('world.terrain.ocean'), lake: msg('world.terrain.lake'),
};
export function terrainHeight(x: number, z: number, config: WorldConfig): number {
  return settlementTerrainHeight(x, z, naturalTerrainHeight(x, z, config), config);
}
export function biomeAt(x: number, z: number, config: WorldConfig, height = terrainHeight(x, z, config)): Biome {
  if (Math.abs(z - riverCenter(x, config)) < config.terrain.riverWidth * 0.8) return 'river';
  if (villagesNear(x, z, 0, config).some(plan => plan.houses.some(house => Math.hypot(x - house.x, z - house.z) < config.population.houseWidth * 1.5))) return 'village';
  if (height > config.terrain.snowLine * 0.7) return 'mountain';
  if (height > config.terrain.elevation * 0.85) return 'highland';
  const climate = surfaceClimate(x, z, config);
  return climate.humidity - climate.temperature * 0.18 > -0.08 ? 'forest' : 'meadow';
}
export function spawnPosition(config: WorldConfig): { x: number; y: number; z: number; yaw: number; pitch: number } {
  const x = 0, z = riverCenter(0, config) - config.terrain.riverWidth * 1.6;
  return { x, y: terrainHeight(x, z, config) + config.physics.eyeHeight, z, yaw: Math.PI, pitch: -0.02 };
}

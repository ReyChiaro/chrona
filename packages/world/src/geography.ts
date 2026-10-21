import type { WorldConfig } from '../../protocol/src/config';
import { sampleLandform } from './landforms';
import { noise, octaveNoise } from './random';
import { smoothRange } from './spline';

/** Natural geography is independent of settlement planning, preventing recursive generation. */
export function riverCenter(x: number, config: WorldConfig): number {
  const t = config.terrain;
  return Math.sin(x / t.riverWavelength * Math.PI * 2) * t.riverAmplitude
    + noise(config.seed, 'river', x / t.riverWavelength, 0) * t.riverAmplitude * 0.35;
}

export function naturalTerrainHeight(x: number, z: number, config: WorldConfig): number {
  const t = config.terrain, distance = Math.abs(z - riverCenter(x, config));
  const bank = t.waterLevel - 1.9 + t.bankHeight * smoothRange(t.riverWidth * 0.28, t.riverWidth * 0.93, distance);
  const floodplain = t.riverWidth * 1.25 + 3;
  const regional = sampleLandform(x, z, config);
  const transition = Math.hypot(t.valleyWidth, 1.875 * regional.height / t.foothillSlope);
  const mountain = regional.height * smoothRange(floodplain, floodplain + transition, distance);
  const rolling = (octaveNoise(config.seed, 'nearby-hills', x / t.hillScale, z / t.hillScale) + 1) / 2;
  const hills = t.hillHeight * (0.25 + rolling * 0.75) * smoothRange(floodplain, floodplain + t.valleyWidth, distance);
  return bank + mountain + hills;
}

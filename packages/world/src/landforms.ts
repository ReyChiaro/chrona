import type { WorldConfig } from '../../protocol/src/config';
import { octaveNoise } from './random';
import { mix, sampleSpline, type Spline } from './spline';

/** Original inland profiles inspired by Minecraft's continentalness/erosion/ridges router. */
const CONTINENTAL_OFFSET: Spline = [
  { at: -1, value: 0.1, derivative: 0 }, { at: -0.55, value: 0.16, derivative: 0.2 },
  { at: -0.2, value: 0.28, derivative: 0.6 }, { at: 0.2, value: 0.6, derivative: 0.7 },
  { at: 0.55, value: 0.85, derivative: 0.5 }, { at: 1, value: 1, derivative: 0 },
];
const EROSION_FACTOR: Spline = [
  { at: -1, value: 1, derivative: 0 }, { at: -0.35, value: 0.94, derivative: -0.3 },
  { at: 0.1, value: 0.65, derivative: -0.9 }, { at: 0.5, value: 0.17, derivative: -0.6 },
  { at: 1, value: 0.03, derivative: 0 },
];
const RIDGE_LIFT: Spline = [
  { at: -1, value: 0, derivative: 0 }, { at: -0.6, value: 0.08, derivative: 0.3 },
  { at: -0.15, value: 0.3, derivative: 0.6 }, { at: 0.35, value: 0.64, derivative: 0.65 },
  { at: 0.8, value: 0.94, derivative: 0.35 }, { at: 1, value: 1, derivative: 0 },
];

export interface TerrainSignals { continentalness: number; erosion: number; weirdness: number; peaksValleys: number }
export interface LandformSample extends TerrainSignals { height: number; ruggedness: number; jaggedness: number }
const bounded = (value: number) => Math.max(-1, Math.min(1, value));

/** The folded ridge signal used by Java's overworld router; not a height by itself. */
export const peaksAndValleys = (weirdness: number): number => -(Math.abs(Math.abs(weirdness) - 2 / 3) - 1 / 3) * 3;

export function terrainSignals(x: number, z: number, config: WorldConfig): TerrainSignals {
  const t = config.terrain, seed = config.seed;
  const continentalness = bounded(octaveNoise(seed, 'continentalness', x / t.continentalScale, z / t.continentalScale) * 1.65);
  const erosion = bounded(octaveNoise(seed, 'erosion', x / t.erosionScale, z / t.erosionScale) * 1.65);
  const weirdness = bounded(octaveNoise(seed, 'weirdness', x / t.mountainScale, z / t.mountainScale, 2) * 1.75);
  return { continentalness, erosion, weirdness, peaksValleys: peaksAndValleys(weirdness) };
}

/** Signal -> spline -> regional offset, relief factor and locally gated detail. */
export function sampleLandform(x: number, z: number, config: WorldConfig): LandformSample {
  const t = config.terrain, signals = terrainSignals(x, z, config);
  const inland = sampleSpline(CONTINENTAL_OFFSET, signals.continentalness);
  const ruggedness = sampleSpline(EROSION_FACTOR, signals.erosion);
  const ridge = sampleSpline(RIDGE_LIFT, signals.peaksValleys);
  const hills = octaveNoise(config.seed, 'rolling-hills', x / t.wavelength, z / t.wavelength);
  const jaggedness = ruggedness * ridge * ridge;
  const detail = octaveNoise(config.seed, 'surface-detail', x / (t.wavelength * 0.35), z / (t.wavelength * 0.35), 2);
  const height = t.elevation * (inland + hills * mix(0.08, 0.22, ruggedness))
    + t.mountainHeight * mix(0.4, 1, inland) * ruggedness * ridge
    + t.roughness * mix(0.08, 0.35, jaggedness) * detail;
  return { ...signals, height: Math.max(0, height), ruggedness, jaggedness };
}

export function surfaceClimate(x: number, z: number, config: WorldConfig): { temperature: number; humidity: number } {
  const scale = config.terrain.erosionScale;
  return {
    temperature: octaveNoise(config.seed, 'temperature', x / (scale * 1.4), z / (scale * 1.4), 2),
    humidity: octaveNoise(config.seed, 'humidity', x / (scale * 0.65), z / (scale * 0.65), 2),
  };
}

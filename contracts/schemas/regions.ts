import { msg } from '../../packages/i18n/src/index';
import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const point = z.object({ x: z.number().min(-400).max(400), z: z.number().min(-400).max(400) }).strict();
export const regionSchema = z.object({
  center: z.object({ x: z.number().finite(), z: z.number().finite() }).strict(),
  radius: z.number().min(60).max(240), transition: z.number().min(12).max(100),
  elevation: z.number().min(-50).max(1000),
  preserveCorridors: z.boolean().default(true),
  operators: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ridge'), height: z.number().min(1).max(180), wavelength: z.number().min(25).max(400), angle: z.number().min(-7).max(7), offset: point }).strict(),
    z.object({ kind: z.literal('volcano'), height: z.number().min(8).max(180), radius: z.number().min(15).max(180), craterRadius: z.number().min(5).max(70), craterDepth: z.number().min(3).max(90), offset: point }).strict(),
    z.object({ kind: z.literal('terrace'), height: z.number().min(-40).max(100), radius: z.number().min(10).max(180), offset: point }).strict(),
  ])).max(12),
  surface: z.object({ color, snowCover: z.boolean().default(false), rockColor: color.optional() }).strict(),
  // Sea level is owned by WorldConfig, never by ground-relative asset placement.
  water: z.object({ kind: z.enum(['ocean', 'lake']), shoreColor: color, shoreHeight: z.number().min(0.3).max(4) }).strict().optional(),
  clearing: z.object({ vegetation: z.boolean(), rocks: z.boolean(), settlements: z.boolean() }).strict(),
  roads: z.array(z.object({ id, points: z.array(point).min(2).max(32), width: z.number().min(4).max(16), closed: z.boolean().default(false) }).strict()).max(24).default([]),
  placements: z.array(z.object({ id, asset: id, position: point, rotation: z.number().min(-7).max(7).default(0), scale: z.number().min(0.25).max(3).default(1), role: z.enum(['building', 'prop']), foundation: z.boolean().default(true), habitat: z.enum(['land', 'underwater']).optional() }).strict()).max(128).default([]),
  scatter: z.array(z.object({ asset: id, count: z.number().int().min(1).max(200), clearance: z.number().min(1).max(15), habitat: z.enum(['land', 'underwater']).optional() }).strict()).max(8).default([]),
  vehicles: z.array(z.object({ id, asset: id, road: id, speed: z.number().min(0.5).max(15), phase: z.number().min(0).max(1) }).strict()).max(32).default([]),
  requirements: z.object({ minRelief: z.number().min(0).max(200).default(0), minSnowCoverage: z.number().min(0).max(1).default(0),
    minCraterDepth: z.number().min(0).max(90).default(0), minBuildings: z.number().int().min(0).max(128).default(0),
    minBuildingHeight: z.number().min(0).max(100).default(0), minTallBuildings: z.number().int().min(0).max(128).default(0), minRoadLength: z.number().min(0).max(3000).default(0),
    minVehicles: z.number().int().min(0).max(32).default(0), minMovingVehicles: z.number().int().min(0).max(32).default(0) }).strict(),
  unsupported: z.array(z.string().min(1).max(300)).max(12).default([]),
}).strict().superRefine((region, ctx) => {
  if (region.transition > region.radius * 0.5) ctx.addIssue({ code: 'custom', message: msg('protocol.regions.the-region-transition-band-cannot-exceed-half-its-radius') });
  const ids = [...region.roads, ...region.placements, ...region.vehicles].map(x => x.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: msg('protocol.regions.road-object-and-vehicle-ids-must-be-unique-within') });
  for (const op of region.operators) if (op.kind === 'volcano' && (op.craterRadius >= op.radius * 0.8 || op.craterDepth > op.height)) ctx.addIssue({ code: 'custom', message: msg('protocol.regions.the-crater-radius-or-depth-is-incompatible-with-the') });
  if (!region.water && [...region.placements, ...region.scatter].some(p => p.habitat === 'underwater')) ctx.addIssue({ code: 'custom', message: msg('protocol.regions.underwater-plants-require-region-water-water-height-is-inherited') });
});
export type RegionRecipe = z.infer<typeof regionSchema>;
export const deploymentSchema = z.object({ package: z.string(), protectedChunks: z.array(z.string()).max(100000), tick: z.number().int().nonnegative() }).strict();
export type RegionDeployment = z.infer<typeof deploymentSchema>;
export interface RegionMetric { criterion: string; actual: number; required: number; passed: boolean }
export interface WaterReport { level: number; area: number; maxDepth: number; shoreline: number; beachArea: number; components: number; largestComponentRatio: number; submergedPlants: number }
export interface RegionReport { status: 'passed' | 'partial' | 'failed'; package: string; chunks: number; metrics: RegionMetric[]; failures: string[]; unsupported: string[]; summary: string; water?: WaterReport }

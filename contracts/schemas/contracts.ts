import { z } from "zod";
import { configSchema } from "./config";
import { contentStateSchema } from "./content";
import { dynamicEntitySchema } from "./physics-contracts";
export { dynamicEntitySchema } from "./physics-contracts";

export const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export const cameraSchema = positionSchema.extend({
  yaw: z.number().finite(),
  pitch: z.number().finite(),
});
export type CameraState = z.infer<typeof cameraSchema>;
export interface TrailPoint {
  x: number;
  y: number;
  z: number;
  tick: number;
}
export interface ChunkRecord {
  q: number;
  r: number;
  fingerprint: string;
  firstTick: number;
  visits: number;
  contentPackages?: string[];
}
export type DynamicEntityState = z.infer<typeof dynamicEntitySchema>;
export const simulationSchema = z.object({
  paused: z.boolean().default(false),
  verticalVelocity: z.number().finite().default(0),
  grounded: z.boolean().default(false),
  entities: z.array(dynamicEntitySchema).max(100000).default([]),
});

export const worldEventSchema = z.object({
  id: z.string(),
  worldId: z.string(),
  tick: z.number().int().nonnegative(),
  worldSeconds: z.number().nonnegative(),
  revision: z.number().int().nonnegative(),
  operation: z.string(),
  objectIds: z.array(z.string()),
  regions: z.array(z.string()),
});
export type WorldEvent = z.infer<typeof worldEventSchema>;
export const snapshotSchema = z.object({
  formatVersion: z.literal(1),
  generatorVersion: z.string().min(1).max(80),
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().min(1).max(100),
  config: configSchema,
  tick: z.number().int().nonnegative(),
  elapsedSeconds: z.number().nonnegative(),
  camera: cameraSchema,
  chunks: z
    .array(
      z.object({
        q: z.number().int().safe(),
        r: z.number().int().safe(),
        fingerprint: z.string(),
        firstTick: z.number().int().nonnegative(),
        visits: z.number().int().nonnegative(),
        contentPackages: z.array(z.string().max(100)).max(16).optional(),
      }),
    )
    .max(100000),
  trail: z
    .array(positionSchema.extend({ tick: z.number().int().nonnegative() }))
    .max(100000),
  savedAt: z.string(),
  simulation: simulationSchema.default({
    paused: false,
    verticalVelocity: 0,
    grounded: false,
    entities: [],
  }),
  content: contentStateSchema.optional(),
  events: z.array(worldEventSchema).max(10000).optional(),
  execution: z
    .object({
      engine: z.literal("rapier3d-compat"),
      engineVersion: z.string(),
      build: z.string(),
      binary: z.string().min(1),
      origin: z.object({ x: z.number().finite(), z: z.number().finite() }),
      player: z.number(),
      playerCollider: z.number(),
      chunkBodies: z.array(z.tuple([z.string(), z.number()])),
      assetBodies: z.array(z.tuple([z.string(), z.number()])),
      entityBodies: z.array(z.tuple([z.string(), z.number()])),
      trafficBodies: z.array(z.tuple([z.string(), z.number()])),
      accumulator: z.number().nonnegative(),
      observerTime: z.number().nonnegative(),
      jumpHeld: z.boolean(),
      pendingDrops: z.array(
        z.object({
          id: z.string(),
          x: z.number(),
          y: z.number(),
          z: z.number(),
        }),
      ),
    })
    .optional(),
});
export type WorldSnapshot = z.infer<typeof snapshotSchema>;
export interface WorldSummary {
  id: string;
  name: string;
  savedAt: string;
  chunks: number;
  seed: string;
}

/** Transport-neutral observation contract for renderers, agents and video providers. */
export interface Observation {
  worldId: string;
  generatorVersion: string;
  tick: number;
  worldSeconds: number;
  revision?: number;
  observerTime?: number;
  camera: CameraState;
  origin: { x: number; z: number };
  activeChunks: { key: string; fingerprint: string }[];
  simulation?: {
    paused: boolean;
    gravity: number;
    activeBodies: number;
    dormantBodies: number;
    entities: DynamicEntityState[];
  };
  viewport?: {
    width: number;
    height: number;
    projectionMatrix: number[];
    cameraMatrix: number[];
  };
}
export interface VideoProvider {
  id: string;
  render(
    request: import("./render-contracts").RenderSubmission,
    signal: AbortSignal,
  ): Promise<import("./render-contracts").RenderJob>;
}
export interface ContentProvider {
  id: string;
  propose(request: {
    prompt: string;
    referenceIds: string[];
    generatorVersion: string;
  }): Promise<{ packageId: string }>;
}

import { msg } from "../../packages/i18n/src/index";
import { z } from "zod";
import { cameraSchema, positionSchema } from "./contracts";
import { objectConstraintSchema } from "./content";
const finite = () => z.number().finite();
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
export const SurfaceTexture = z.object({
  pattern: z.enum(["wood", "stone", "brick", "fabric", "noise"]),
  seed: z.number().int().min(0).max(2147483647),
  repeat: z.tuple([finite().min(1).max(16), finite().min(1).max(16)]),
  contrast: finite().min(0).max(0.6),
  bump: finite().min(0).max(0.15),
});
export const BoundMaterial = z.object({
  id: z.string().max(64),
  label: z.string().min(1).max(80),
  partIndices: z.array(z.number().int().min(0).max(31)).max(32),
  color,
  roughness: finite().min(0).max(1),
  metalness: finite().min(0).max(1).optional(),
  opacity: finite().min(0.1).max(1).optional(),
  emissive: color.optional(),
  emissiveIntensity: finite().min(0).max(4).optional(),
  flatShading: z.boolean().optional(),
  texture: SurfaceTexture.optional(),
});
export const ObjectAppearance = z.object({
  colors: z.array(color).max(4).default([]),
  roughness: finite().min(0).max(1),
  effect: z.enum(["none", "petals", "fireflies"]).default("none"),
  emissiveColors: z.array(color).max(16).default([]),
  materials: z.array(BoundMaterial).max(8).default([]),
});
export const SceneEnvironment = z.object({
  hour: finite().min(0).lt(24),
  paused: z.boolean().default(false),
  waterLevel: finite().optional(),
});
const boundOrder = [
  [0, 2],
  [1, 3],
];
const normalizedBounds = z
  .tuple([
    finite().min(0).max(1),
    finite().min(0).max(1),
    finite().min(0).max(1),
    finite().min(0).max(1),
  ])
  .refine(
    (bounds) => boundOrder.every(([low, high]) => bounds[low] <= bounds[high]),
    msg(
      "protocol.recording.object-screen-coordinates-must-be-a-normalized-bounding-box",
    ),
  )
  .meta({ "x-ordered": boundOrder });
export const SceneObject = z.object({
  id: z.string().min(1).max(160),
  kind: z.string().max(100),
  label: z.string().max(120),
  distance: finite().nonnegative(),
  band: z.enum(["near", "middle", "far"]),
  position: positionSchema,
  stateHash: z.string().max(100),
  bounds: normalizedBounds.optional(),
  constraint: objectConstraintSchema.optional(),
  appearance: ObjectAppearance.optional(),
});
export const SceneSnapshot = z.object({
  evidenceLevel: z.literal("frustum-candidates").optional(),
  observerTime: finite().nonnegative().optional(),
  budgets: z.record(z.string(), z.number().int()).optional(),
  omitted: z.number().int().nonnegative().optional(),
  time: finite().nonnegative(),
  worldId: z.string().min(1).max(80),
  tick: z.number().int().nonnegative(),
  worldSeconds: finite().nonnegative(),
  revision: z.number().int().nonnegative().default(0),
  camera: cameraSchema,
  objects: z.array(SceneObject).max(96).default([]),
  distantChunks: z
    .array(z.record(z.string(), z.unknown()))
    .max(100)
    .default([]),
  environment: SceneEnvironment.optional(),
  weather: z.array(z.record(z.string(), z.unknown())).max(16).default([]),
  edits: z.array(z.record(z.string(), z.unknown())).max(24).default([]),
  regions: z.array(z.record(z.string(), z.unknown())).max(256).default([]),
});
export const RecordingEdit = z.object({
  time: finite().nonnegative(),
  frame: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  objectIds: z.array(z.string()).max(32),
  actions: z
    .array(z.enum(["create", "update", "delete", "undo", "constraint"]))
    .max(32),
});
export const AdapterSelection = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/),
  scale: finite().min(0).max(4).default(1),
});
export const RouteRequest = z
  .object({
    recording_id: z.string().regex(/^[a-f0-9-]{36}$/),
    prompt: z.string().max(6000).default(""),
    system_prompt: z.string().max(2200).default(""),
    parameters: z.record(z.string(), z.unknown()).default({}),
    adapters: z.array(AdapterSelection).max(8).default([]),
    frame_stride: z.number().int().min(1).max(1000000).default(1),
    segment_seconds: finite().min(0.5).max(30).default(3.5),
    overlap_frames: z.number().int().min(1).max(120).default(9),
    retries: z.number().int().min(0).max(3).default(1),
    budgets: z
      .record(z.string(), z.number().int())
      .default({ near: 12, middle: 8, far: 4 }),
    prompt_enhancement: z.boolean().default(false),
  })
  .strict();

export const VideoRequest = RouteRequest;

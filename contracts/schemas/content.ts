import { msg } from "../../packages/i18n/src/index";
import { z } from "zod";
import { dynamicEntitySchema } from "./physics-contracts";
import { regionSchema, deploymentSchema } from "./regions";
import {
  materialDefinitionSchema,
  materialIdSchema,
  type MaterialDefinition,
} from "./materials";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const vector = (component: z.ZodNumber) =>
  z.tuple([component, component, component]);
export const assetRecipeSchema = z
  .object({
    label: z.string().min(1).max(120),
    materials: z
      .record(materialIdSchema, materialDefinitionSchema)
      .refine(
        (value) => Object.keys(value).length <= 16,
        msg("protocol.content.an-asset-may-define-at-most-16-materials"),
      )
      .optional(),
    parts: z
      .array(
        z
          .object({
            shape: z.enum(["box", "sphere", "cone", "cylinder"]),
            size: vector(z.number().positive().max(32)),
            position: vector(z.number().min(-32).max(32)),
            material: materialIdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(32),
    collider: z
      .object({
        halfExtents: vector(z.number().positive().max(8)),
        center: vector(z.number().min(-16).max(16)),
      })
      .strict()
      .nullable(),
    colliders: z
      .array(
        z
          .object({
            halfExtents: vector(z.number().positive().max(32)),
            center: vector(z.number().min(-64).max(64)),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    effect: z.enum(["none", "petals", "fireflies"]).default("none"),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    recipe.parts.forEach((part, index) => {
      if (!recipe.materials?.[part.material])
        ctx.addIssue({
          code: "custom",
          path: ["parts", index, "material"],
          message: msg(
            "protocol.content.material-is-undefined-declare-it-in-this-asset-s",
            { p0: part.material },
          ),
        });
    });
  });
export const contentPackageSchema = z
  .object({
    protocol: z.union([z.literal(1), z.literal(2)]),
    id,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    title: z.string().min(1).max(100),
    description: z.string().max(2000),
    assets: z.record(id, assetRecipeSchema).default({}),
    weather: z
      .object({
        kind: z.enum(["snow", "fireflies"]),
        density: z.number().min(0.05).max(1),
      })
      .strict()
      .optional(),
    region: regionSchema.optional(),
  })
  .strict()
  .superRefine((pack, ctx) => {
    if (pack.region && pack.protocol !== 2)
      ctx.addIssue({
        code: "custom",
        message: msg("protocol.content.regional-scenes-require-protocol-2"),
      });
    if (pack.protocol === 2 && !pack.region)
      ctx.addIssue({
        code: "custom",
        message: msg("protocol.content.protocol-2-requires-a-region"),
      });
    for (const item of [
      ...(pack.region?.placements ?? []),
      ...(pack.region?.scatter ?? []),
      ...(pack.region?.vehicles ?? []),
    ])
      if (!pack.assets[item.asset])
        ctx.addIssue({
          code: "custom",
          message: msg(
            "protocol.content.the-region-references-a-missing-asset",
            { p0: item.asset },
          ),
        });
    for (const vehicle of pack.region?.vehicles ?? [])
      if (!pack.region?.roads.some((r) => r.id === vehicle.road && r.closed))
        ctx.addIssue({
          code: "custom",
          message: msg(
            "protocol.content.vehicle-requires-a-valid-closed-road",
            { p0: vehicle.id },
          ),
        });
  });
export type AssetRecipe = z.infer<typeof assetRecipeSchema>;
export type ContentPackage = z.infer<typeof contentPackageSchema>;
export const packageKey = (
  value: Pick<ContentPackage, "id" | "version">,
): string => `${value.id}@${value.version}`;
export const objectConstraintSchema = z.object({
  objectId: z.string().min(1).max(160),
  text: z.string().min(1).max(1500),
  referenceIds: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(8)
    .default([]),
});
export type ObjectConstraint = z.infer<typeof objectConstraintSchema>;
export const storedObjectSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(["pine", "birch", "shrub", "rock", "house", "bridge", "custom"]),
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
  rotation: z.number().finite(),
  scale: z.number().positive().max(8),
  variant: z.number().finite(),
  design: assetRecipeSchema.optional(),
  contentKey: z.string().max(100).optional(),
  role: z.enum(["building", "prop", "vehicle"]).optional(),
});
const objectStateSchema = z.object({
  addition: storedObjectSchema.optional(),
  patch: storedObjectSchema.optional(),
  resolved: storedObjectSchema.optional(),
  deleted: z.boolean(),
  override: z.object({ package: z.string(), asset: id }).optional(),
  constraint: objectConstraintSchema.optional(),
  dynamic: dynamicEntitySchema.optional(),
});
export const editEventSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  tick: z.number().int(),
  worldSeconds: z.number(),
  action: z.enum(["create", "update", "delete", "undo", "constraint"]),
  objectId: z.string(),
  label: z.string(),
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
});
export type EditEvent = z.infer<typeof editEventSchema>;
export type StoredObject = z.infer<typeof storedObjectSchema>;
export type ObjectEditState = z.infer<typeof objectStateSchema>;
export const contentStateSchema = z
  .object({
    engineVersion: z
      .literal("content-operators@1")
      .default("content-operators@1"),
    revision: z.number().int().nonnegative().default(0),
    packages: z.array(contentPackageSchema).max(256).default([]),
    activePackages: z.array(z.string().max(100)).max(16).default([]),
    overrides: z
      .record(
        z.string().max(160),
        z.object({ package: z.string(), asset: id }).strict(),
      )
      .default({}),
    constraints: z.array(objectConstraintSchema).max(5000).default([]),
    additions: z.record(z.string(), storedObjectSchema).default({}),
    patches: z.record(z.string(), storedObjectSchema).default({}),
    deletedIds: z.array(z.string()).max(100000).default([]),
    objectVersions: z
      .record(z.string(), z.number().int().nonnegative())
      .default({}),
    history: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          changes: z
            .array(
              z.object({
                id: z.string(),
                before: objectStateSchema,
                after: objectStateSchema,
              }),
            )
            .max(32),
          activeBefore: z.array(z.string()).optional(),
        }),
      )
      .max(50)
      .default([]),
    events: z.array(editEventSchema).max(200).default([]),
    appliedRequests: z.array(z.string()).max(500).default([]),
    regionalDeployments: z.array(deploymentSchema).max(256).default([]),
  })
  .strict();
export type ContentState = z.infer<typeof contentStateSchema>;
export const emptyContent = (): ContentState => contentStateSchema.parse({});

export interface ContextObject {
  id: string;
  kind: string;
  label: string;
  distance: number;
  band: "near" | "middle" | "far";
  position: { x: number; y: number; z: number };
  stateHash: string;
  bounds?: [number, number, number, number];
  constraint?: ObjectConstraint;
  appearance?: {
    colors: string[];
    roughness: number;
    effect: AssetRecipe["effect"];
    emissiveColors?: string[];
    materials?: (MaterialDefinition & { id: string; partIndices: number[] })[];
  };
}
export interface SceneContext {
  evidenceLevel?: "frustum-candidates";
  observerTime?: number;
  time: number;
  worldId: string;
  tick: number;
  worldSeconds: number;
  revision: number;
  camera: { x: number; y: number; z: number; yaw: number; pitch: number };
  objects: ContextObject[];
  distantChunks: {
    key: string;
    fingerprint: string;
    visible?: boolean;
    biome?: string;
    distance?: number;
    elevation?: number;
    contentPackages?: string[];
  }[];
  budgets: { near: number; middle: number; far: number };
  omitted: number;
  environment?: { hour: number; paused: boolean; waterLevel?: number };
  weather?: { kind: string; density: number; package: string }[];
  regions?: {
    key: string;
    title: string;
    center: { x: number; z: number };
    radius: number;
    features: string[];
  }[];
  edits?: (EditEvent & {
    subject?: Pick<ContextObject, "kind" | "label" | "appearance">;
  })[];
}

export const selectionSchema = z.object({
  kind: z.enum(["object", "ground"]),
  objectId: z.string().optional(),
  version: z.number().int().nonnegative().optional(),
  label: z.string(),
  point: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }),
  normal: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
    })
    .optional(),
});
export type SceneSelection = z.infer<typeof selectionSchema>;
export const editPlanSchema = z.object({
  requestId: z.string().min(1).max(80),
  worldId: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  action: z.enum([
    "create",
    "replace",
    "move",
    "delete",
    "constraint",
    "undo",
    "future",
  ]),
  targetId: z.string().max(160).optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  point: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
    })
    .optional(),
  delta: z
    .object({
      x: z.number().min(-50).max(50),
      y: z.number().min(-20).max(20),
      z: z.number().min(-50).max(50),
    })
    .optional(),
  asset: id.optional(),
  constraint: z.string().max(1500).optional(),
  referenceIds: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(8)
    .default([]),
  intent: z.string().max(12000).optional(),
});
export type EditPlan = z.infer<typeof editPlanSchema>;

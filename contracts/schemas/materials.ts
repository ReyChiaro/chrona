import { msg } from "../../packages/i18n/src/index";
import { z } from "zod";
import type { AssetRecipe, ContextObject } from "./content";

export const materialIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const materialColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const surfaceTextureSchema = z
  .object({
    pattern: z.enum(["wood", "stone", "brick", "fabric", "noise"]),
    seed: z.number().int().min(0).max(2147483647),
    repeat: z.tuple([z.number().min(1).max(16), z.number().min(1).max(16)]),
    contrast: z.number().min(0).max(0.6),
    bump: z.number().min(0).max(0.15),
  })
  .strict();

/** Bounded, serializable PBR data. No external URLs or executable shaders. */
export const materialDefinitionSchema = z
  .object({
    label: z.string().min(1).max(80),
    color: materialColorSchema,
    roughness: z.number().min(0).max(1),
    metalness: z.number().min(0).max(1).optional(),
    opacity: z.number().min(0.1).max(1).optional(),
    emissive: materialColorSchema.optional(),
    emissiveIntensity: z.number().min(0).max(4).optional(),
    flatShading: z.boolean().optional(),
    texture: surfaceTextureSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.emissiveIntensity !== undefined && !value.emissive)
      ctx.addIssue({
        code: "custom",
        message: msg(
          "protocol.materials.emissiveintensity-requires-emissive-to-be-declared",
        ),
      });
  });
export type MaterialDefinition = z.infer<typeof materialDefinitionSchema>;
export type SurfaceTexture = z.infer<typeof surfaceTextureSchema>;

export function resolvePartMaterial(
  recipe: AssetRecipe,
  part: AssetRecipe["parts"][number],
): MaterialDefinition {
  const material = recipe.materials?.[part.material];
  if (!material)
    throw new Error(
      msg("protocol.materials.material-is-undefined", { p0: part.material }),
    );
  return material;
}

export function materialBindings(
  recipe: AssetRecipe,
): (MaterialDefinition & { id: string; partIndices: number[] })[] {
  const materials = new Map<
    string,
    MaterialDefinition & { id: string; partIndices: number[] }
  >();
  recipe.parts.forEach((part, index) => {
    const id = part.material;
    if (!materials.has(id))
      materials.set(id, {
        id,
        ...resolvePartMaterial(recipe, part),
        partIndices: [],
      });
    materials.get(id)!.partIndices.push(index);
  });
  return [...materials.values()];
}

/** Summarize resolved bindings, so text conditioning agrees with the actual proxy. */
export function assetAppearance(
  recipe?: AssetRecipe,
): ContextObject["appearance"] {
  if (!recipe?.parts.length) return undefined;
  const resolved = recipe.parts.map((part) =>
    resolvePartMaterial(recipe, part),
  );
  return {
    colors: [...new Set(resolved.map((m) => m.color))].slice(0, 4),
    roughness:
      resolved.reduce((sum, m) => sum + m.roughness, 0) / resolved.length,
    effect: recipe.effect,
    emissiveColors: [
      ...new Set(
        resolved.flatMap((m) =>
          m.emissive && (m.emissiveIntensity ?? 1) > 0 ? [m.emissive] : [],
        ),
      ),
    ].slice(0, 16),
    materials: materialBindings(recipe).slice(0, 8),
  };
}

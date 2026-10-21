import { z } from 'zod';
const position = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
export const dynamicEntitySchema = z.object({
  id: z.string().min(1).max(120), kind: z.literal('crate'), position,
  rotation: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite(), w: z.number().finite() }),
  linearVelocity: position, angularVelocity: position, halfExtent: z.number().min(0.1).max(3),
  updatedTick: z.number().int().nonnegative(), sleeping: z.boolean(),
});

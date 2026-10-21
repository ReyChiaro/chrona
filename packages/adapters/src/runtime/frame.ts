import type { WorldSnapshot, Observation } from "../../../protocol/src/contracts";
import type { ChunkData, Asset } from "../../../world/src/generator";

/** Chunk payloads are upserts; only an initial/query frame replaces the active set. */
export type RuntimeFrame = {
  snapshot: WorldSnapshot;
  observation: Observation;
  chunks?: ChunkData[];
  removedChunks?: string[];
  resetChunks?: boolean;
  cameraEpoch: number;
  lookSequence: number;
  origin: { x: number; z: number };
  grounded: boolean;
  traffic: Asset[];
  metrics: Record<string, unknown>;
};

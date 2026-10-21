import { LocalizedError } from "../../i18n/src/index";
import { msg } from "../../i18n/src/index";
import type { ChunkRecord } from "../../protocol/src/contracts";
import type { WorldConfig } from "../../protocol/src/config";
import { generateChunk, type Asset, type ChunkData } from "./generator";
import { hexDisk, hexKey, worldToHex, type Hex } from "./hex";

export interface ChunkChange {
  added: ChunkData[];
  removed: string[];
  center: Hex;
}
export type ChunkFactory = (
  cell: Hex,
  config: WorldConfig,
  record?: ChunkRecord,
) => ChunkData;

export class ChunkManager {
  readonly active = new Map<string, ChunkData>();
  readonly records = new Map<string, ChunkRecord>();
  center: Hex = { q: 0, r: 0 };
  private currentSignature = "";
  constructor(
    public config: WorldConfig,
    private generate: ChunkFactory = generateChunk,
  ) {}

  update(x: number, z: number, tick: number, force = false): ChunkChange {
    const center = worldToHex(x, z, this.config.chunkRadius);
    const signature = `${hexKey(center)}:${this.config.loadRange}`;
    if (!force && signature === this.currentSignature)
      return { added: [], removed: [], center };
    this.currentSignature = signature;
    this.center = center;
    const wanted = hexDisk(center, this.config.loadRange);
    const wantedKeys = new Set(wanted.map(hexKey));
    const removed = [...this.active.keys()].filter(
      (key) => !wantedKeys.has(key),
    );
    for (const key of removed) this.active.delete(key);
    const added: ChunkData[] = [];
    for (const cell of wanted) {
      const key = hexKey(cell);
      if (this.active.has(key)) continue;
      const previous = this.records.get(key);
      const chunk = this.generate(cell, this.config, previous);
      if (previous && previous.fingerprint !== chunk.fingerprint)
        throw new LocalizedError(
          "adapters.runtime.chunk-has-a-generation-fingerprint-that-differs-from-the",
          { p0: key },
        );
      this.records.set(key, {
        ...cell,
        fingerprint: chunk.fingerprint,
        firstTick: previous?.firstTick ?? tick,
        visits: (previous?.visits ?? 0) + 1,
        ...(chunk.contentPackages?.length
          ? { contentPackages: chunk.contentPackages }
          : {}),
      });
      this.active.set(key, chunk);
      added.push(chunk);
    }
    return { added, removed, center };
  }

  get assets(): Map<string, Asset> {
    const result = new Map<string, Asset>();
    for (const chunk of this.active.values())
      for (const asset of chunk.assets) {
        const owner = worldToHex(asset.x, asset.z, this.config.chunkRadius);
        if (hexKey(owner) === chunk.key) result.set(asset.id, asset);
      }
    return result;
  }
}

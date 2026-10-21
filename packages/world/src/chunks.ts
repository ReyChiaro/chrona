import { LocalizedError } from "../../i18n/src/index";
import { msg } from "../../i18n/src/index";
import type { ChunkRecord } from "../../protocol/src/contracts";
import { generationSignature, type WorldConfig } from "../../protocol/src/config";
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
  private prepared = new Map<string, ChunkData>();
  private preparedSignature = "";
  get preparedCount(): number { return this.prepared.size; }
  constructor(
    public config: WorldConfig,
    private generate: ChunkFactory = generateChunk,
  ) {}

  invalidatePrepared(): void {
    this.prepared.clear();
    this.preparedSignature = generationSignature(this.config);
  }

  private checkPrepared(): void {
    if (this.preparedSignature !== generationSignature(this.config)) this.invalidatePrepared();
  }

  private cache(chunk: ChunkData): void {
    this.prepared.delete(chunk.key);
    this.prepared.set(chunk.key, chunk);
    const limit = Math.max(32, this.active.size * 3);
    while (this.prepared.size > limit) this.prepared.delete(this.prepared.keys().next().value!);
  }

  nextPreparation(x: number, z: number): Hex | undefined {
    this.checkPrepared();
    const center = worldToHex(x, z, this.config.chunkRadius);
    const cells = hexDisk(center, this.config.loadRange + 1);
    for (const cell of cells) {
      const key = hexKey(cell);
      if (this.active.has(key) || this.prepared.has(key)) continue;
      return cell;
    }
    return undefined;
  }

  /** Accept background geometry without creating visits, entities or saved records. */
  storePrepared(chunk: ChunkData): void {
    this.checkPrepared();
    if (!this.active.has(chunk.key)) this.cache(chunk);
  }

  /** Synchronous preparation for headless callers; the browser prepares in a separate Worker. */
  prepareNext(x: number, z: number): boolean {
    const cell = this.nextPreparation(x, z);
    if (!cell) return false;
    this.preparedChunk(cell);
    return true;
  }

  preparedChunk(cell: Hex): ChunkData {
    this.checkPrepared();
    const key = hexKey(cell);
    const chunk = this.active.get(key) ?? this.prepared.get(key) ?? this.generate(cell, this.config, this.records.get(key));
    if (!this.active.has(key)) this.cache(chunk);
    return chunk;
  }

  update(x: number, z: number, tick: number, force = false): ChunkChange {
    this.checkPrepared();
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
    for (const key of removed) {
      this.cache(this.active.get(key)!);
      this.active.delete(key);
    }
    const added: ChunkData[] = [];
    for (const cell of wanted) {
      const key = hexKey(cell);
      if (this.active.has(key)) continue;
      const previous = this.records.get(key);
      const chunk = this.preparedChunk(cell);
      this.prepared.delete(key);
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

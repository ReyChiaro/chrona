import { LocalizedError } from "../../i18n/src/index";
import { msg } from "../../i18n/src/index";
import {
  contentPackageSchema,
  contentStateSchema,
  emptyContent,
  packageKey,
  type ContentPackage,
  type ContentState,
} from "../../protocol/src/content";
import type { WorldConfig } from "../../protocol/src/config";
import type { ChunkRecord } from "../../protocol/src/contracts";
import { hashString } from "./random";
import { generateChunk, type Asset, type ChunkData } from "./generator";
import { hexKey, worldToHex, type Hex } from "./hex";
import { applyRegion, regionCells } from "./regions";
import type { RegionDeployment } from "../../protocol/src/regions";

export function generateContentChunk(
  cell: Hex,
  config: WorldConfig,
  packages: ContentPackage[] = [],
  deployments: RegionDeployment[] = [],
): ChunkData {
  const regional = packages.filter((p) => p.region);
  const chunk = generateChunk(cell, config);
  if (!regional.length) return chunk;
  const base = chunk.fingerprint;
  for (const pack of regional)
    applyRegion(
      chunk,
      pack,
      deployments.find((d) => d.package === packageKey(pack)),
      config,
    );
  chunk.assets.sort((a, b) => a.id.localeCompare(b.id));
  chunk.fingerprint = hashString(
    JSON.stringify({
      engine: "regional-surfaces@1",
      base,
      regional,
      deployments: deployments.filter((d) =>
        regional.some((p) => packageKey(p) === d.package),
      ),
      positions: [...chunk.positions],
      colors: [...chunk.colors],
      assets: chunk.assets,
      roads: chunk.roads,
    }),
  ).toString(16);
  return chunk;
}

export class WorldContent {
  state: ContentState;
  constructor(state?: ContentState) {
    this.state = contentStateSchema.parse(
      structuredClone(state ?? emptyContent()),
    );
    this.validate();
  }
  get weatherPackages(): ContentPackage[] {
    // Installing an object recipe does not activate its package as global weather.
    const enabled = new Set(this.state.activePackages);
    const latest = new Map<string, ContentPackage>();
    for (const pack of this.state.packages)
      if (pack.weather && !pack.region && enabled.has(packageKey(pack)))
        latest.set(pack.id, pack);
    return [...latest.values()].slice(-16);
  }
  regionalWeather(active: Iterable<ChunkData>): ContentPackage[] {
    const pins = new Set(
      [...active].flatMap((chunk) => chunk.contentPackages ?? []),
    );
    return this.state.packages.filter(
      (pack) => pack.region && pack.weather && pins.has(packageKey(pack)),
    );
  }
  private validate(): void {
    const keys = this.state.packages.map(packageKey);
    if (new Set(keys).size !== keys.length)
      throw new LocalizedError("world.content.duplicate-content-version");
    for (const key of this.state.activePackages)
      if (!keys.includes(key))
        throw new LocalizedError("world.content.missing-content-package", {
          p0: key,
        });
    for (const value of Object.values(this.state.overrides))
      if (
        !this.state.packages.find((p) => packageKey(p) === value.package)
          ?.assets[value.asset]
      )
        throw new LocalizedError(
          "world.content.an-object-patch-references-a-missing-asset",
        );
  }
  install(value: ContentPackage, activate: boolean): void {
    const pack = contentPackageSchema.parse(value),
      key = packageKey(pack);
    const previous = this.state.packages.find((p) => packageKey(p) === key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(pack))
      throw new LocalizedError(
        "world.content.installed-versions-are-immutable-publish-a-new-version",
      );
    if (!previous && this.state.packages.length >= 256)
      throw new LocalizedError(
        "world.content.the-world-content-package-limit-has-been-reached",
      );
    const active = activate
      ? [
          ...this.state.activePackages.filter(
            (k) => !k.startsWith(`${pack.id}@`),
          ),
          key,
        ]
      : this.state.activePackages;
    if (active.length > 16)
      throw new LocalizedError(
        "world.content.no-more-than-16-content-packages-may-be-active",
      );
    if (!previous) this.state.packages.push(pack);
    this.state.activePackages = active;
    this.state.revision++;
  }
  deployRegion(
    pack: ContentPackage,
    protectedChunks: string[],
    tick: number,
  ): void {
    if (!pack.region)
      throw new LocalizedError("world.content.missing-region-recipe");
    this.install(pack, true);
    const key = packageKey(pack);
    if (!this.state.regionalDeployments.some((d) => d.package === key))
      this.state.regionalDeployments.push({
        package: key,
        protectedChunks: [...new Set(protectedChunks)].sort(),
        tick,
      });
  }
  generate(cell: Hex, config: WorldConfig, record?: ChunkRecord): ChunkData {
    const pins = record
      ? (record.contentPackages ?? [])
      : this.state.activePackages.filter((key) => {
          const pack = this.state.packages.find((p) => packageKey(p) === key)!;
          return (
            !pack.region ||
            regionCells(pack.region, config).some(
              (c) => hexKey(c) === hexKey(cell),
            )
          );
        });
    const packages = pins.map((key) => {
      const p = this.state.packages.find((p) => packageKey(p) === key);
      if (!p)
        throw new LocalizedError(
          "world.content.a-chunk-is-missing-pinned-content-version",
          { p0: key },
        );
      return p;
    });
    const chunk = generateContentChunk(
      cell,
      config,
      packages,
      this.state.regionalDeployments,
    );
    chunk.contentPackages = pins;
    for (const asset of chunk.assets) this.applyOverride(asset);
    chunk.assets = this.materialize(chunk.assets, cell, config);
    return chunk;
  }
  materialize(base: Asset[], cell: Hex, config: WorldConfig): Asset[] {
    const deleted = new Set(this.state.deletedIds),
      key = hexKey(cell);
    const assets = base.filter(
      (a) => !deleted.has(a.id) && !this.state.patches[a.id],
    );
    for (const a of [
      ...Object.values(this.state.additions),
      ...Object.values(this.state.patches),
    ]) {
      if (
        deleted.has(a.id) ||
        hexKey(worldToHex(a.x, a.z, config.chunkRadius)) !== key
      )
        continue;
      const copy = structuredClone(a);
      this.applyOverride(copy);
      assets.push(copy);
    }
    return assets.sort((a, b) => a.id.localeCompare(b.id));
  }
  applyOverride(asset: Asset): void {
    const patch = this.state.overrides[asset.id];
    if (patch) {
      asset.design = this.state.packages.find(
        (p) => packageKey(p) === patch.package,
      )!.assets[patch.asset];
      asset.contentKey = patch.package;
    }
  }
}

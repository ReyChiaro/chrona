import { LocalizedError } from '../../i18n/src/index';
import { msg } from '../../i18n/src/index';
import { contentPackageSchema, contentStateSchema, emptyContent, packageKey, type ContentPackage, type ContentState } from '../../protocol/src/content';
import type { WorldConfig } from '../../protocol/src/config';
import type { ChunkRecord } from '../../protocol/src/contracts';
import { generateChunk, type Asset, type ChunkData } from './generator';
import { hexKey, worldToHex, type Hex } from './hex';
import { hashString, randomAt } from './random';
import { roadDistance, riverCenter } from './terrain';
import { surfaceHeight } from './surface';
import { applyRegion, regionCells } from './regions';
import type { RegionDeployment } from '../../protocol/src/regions';

/** Terrain operators have a C1 zero border: new content never lifts an old seam. */
function borderDistance(x: number, z: number, chunk: ChunkData): number {
  let distance = Infinity;
  const points = chunk.boundary;
  for (let i = 0; i < 6; i++) {
    const a = points[i * points.length / 6], b = points[((i + 1) * points.length / 6) % points.length];
    distance = Math.min(distance, Math.abs((b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x)) / Math.hypot(b.x - a.x, b.z - a.z));
  }
  return distance;
}
const fade = (value: number, low: number, high: number) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};
const borderWeight = (x: number, z: number, chunk: ChunkData, radius: number) => fade(borderDistance(x, z, chunk), 0, radius * 0.32);

function generateLegacyChunk(cell: Hex, config: WorldConfig, packages: ContentPackage[] = []): ChunkData {
  const chunk = generateChunk(cell, config);
  if (!packages.length) return chunk;
  const base = chunk.fingerprint;
  const deltaAt = (x: number, z: number): number => {
    const gx = x + chunk.center.x, gz = z + chunk.center.z;
    // Existing roads, buildings and water retain their original supporting surface.
    let protection = fade(roadDistance(gx, gz, config), config.population.roadWidth * 2, config.population.roadWidth * 4) *
      fade(Math.abs(gz - riverCenter(gx, config)), config.terrain.riverWidth * 1.8, config.terrain.riverWidth * 2.6);
    for (const a of chunk.assets) if (a.kind === 'house' || a.kind === 'bridge') protection *= fade(Math.hypot(a.x - gx, a.z - gz), config.population.houseWidth * 1.4, config.population.houseWidth * 2);
    return packages.reduce((height, p) => height + (p.terrain ? p.terrain.amplitude *
      Math.sin(gx / p.terrain.wavelength * Math.PI * 2) * Math.sin(gz / p.terrain.wavelength * Math.PI * 2) : 0), 0) * borderWeight(x, z, chunk, config.chunkRadius) * protection;
  };
  for (let i = 0; i < chunk.positions.length; i += 3) {
    chunk.positions[i + 1] += deltaAt(chunk.positions[i], chunk.positions[i + 2]);
    for (const p of packages) if (p.terrain) {
      const rgb = p.terrain.tint.match(/\w\w/g)!.map(c => Math.pow(parseInt(c, 16) / 255, 2.2));
      const blend = borderWeight(chunk.positions[i], chunk.positions[i + 2], chunk, config.chunkRadius) * 0.4;
      for (let j = 0; j < 3; j++) chunk.colors[i + j] = chunk.colors[i + j] * (1 - blend) + rgb[j] * blend;
    }
  }
  for (const a of chunk.assets) {
    // Ownership prevents recipes on opposite sides from changing the same tree.
    if (hexKey(worldToHex(a.x, a.z, config.chunkRadius)) !== chunk.key) continue;
    if (!['house', 'bridge'].includes(a.kind)) a.y = surfaceHeight(chunk, a.x, a.z) ?? a.y;
  }
  for (const p of packages) if (p.terrain?.scatterAsset) {
    const design = p.assets[p.terrain.scatterAsset], spacing = 9;
    const radius = Math.max(...design.parts.map(part => Math.hypot(part.position[0], part.position[2]) + Math.hypot(part.size[0], part.size[2]) / 2));
    for (let ix = Math.floor((chunk.center.x - config.chunkRadius) / spacing); ix <= Math.ceil((chunk.center.x + config.chunkRadius) / spacing); ix++) {
      for (let iz = Math.floor((chunk.center.z - config.chunkRadius) / spacing); iz <= Math.ceil((chunk.center.z + config.chunkRadius) / spacing); iz++) {
        if (randomAt(config.seed, packageKey(p), ix, iz) > p.terrain.density) continue;
        const x = (ix + randomAt(p.id, 'scatter-x', ix, iz)) * spacing, z = (iz + randomAt(p.id, 'scatter-z', ix, iz)) * spacing;
        if (hexKey(worldToHex(x, z, config.chunkRadius)) !== chunk.key || borderDistance(x - chunk.center.x, z - chunk.center.z, chunk) < radius + 1) continue;
        if (roadDistance(x, z, config) < config.population.roadWidth + radius || Math.abs(z - riverCenter(x, config)) < config.terrain.riverWidth * 1.3 + radius) continue;
        if (chunk.assets.some(a => Math.hypot(a.x - x, a.z - z) < radius + (a.kind === 'house' ? config.population.houseWidth : design.collider ? 5 : 1))) continue;
        const y = surfaceHeight(chunk, x, z);
        if (y === undefined || y < config.terrain.waterLevel + 0.2) continue;
        chunk.assets.push({ id: `content:${hashString(packageKey(p)).toString(16)}:${ix}:${iz}`, kind: 'custom', x, y, z, scale: 1,
          rotation: randomAt(p.id, 'rotation', ix, iz) * Math.PI * 2, variant: 0, design, contentKey: packageKey(p) });
      }
    }
  }
  chunk.assets.sort((a, b) => a.id.localeCompare(b.id));
  chunk.fingerprint = hashString(JSON.stringify({ engine: 'content-operators@1', base, packages, positions: [...chunk.positions], assets: chunk.assets })).toString(16);
  return chunk;
}

/** Version-one generation remains byte-for-byte compatible with existing chunk fingerprints. */
export function generateContentChunk(cell: Hex, config: WorldConfig, packages: ContentPackage[] = [], deployments: RegionDeployment[] = []): ChunkData {
  const regional = packages.filter(p => p.region);
  const chunk = generateLegacyChunk(cell, config, packages.filter(p => !p.region));
  if (!regional.length) return chunk;
  const base = chunk.fingerprint;
  for (const pack of regional) applyRegion(chunk, pack, deployments.find(d => d.package === packageKey(pack)), config);
  chunk.assets.sort((a, b) => a.id.localeCompare(b.id));
  chunk.fingerprint = hashString(JSON.stringify({ engine: 'regional-surfaces@1', base, regional, deployments: deployments.filter(d => regional.some(p => packageKey(p) === d.package)),
    positions: [...chunk.positions], colors: [...chunk.colors], assets: chunk.assets, roads: chunk.roads })).toString(16);
  return chunk;
}

export class WorldContent {
  state: ContentState;
  constructor(state?: ContentState) { this.state = contentStateSchema.parse(structuredClone(state ?? emptyContent())); this.validate(); }
  get weatherPackages(): ContentPackage[] {
    // Installing an object recipe does not activate its package as global weather.
    const enabled = new Set(this.state.activePackages);
    const latest = new Map<string, ContentPackage>();
    for (const pack of this.state.packages) if (pack.weather && !pack.region && enabled.has(packageKey(pack))) latest.set(pack.id, pack);
    return [...latest.values()].slice(-16);
  }
  regionalWeather(active: Iterable<ChunkData>): ContentPackage[] {
    const pins = new Set([...active].flatMap(chunk => chunk.contentPackages ?? []));
    return this.state.packages.filter(pack => pack.region && pack.weather && pins.has(packageKey(pack)));
  }
  private validate(): void {
    const keys = this.state.packages.map(packageKey);
    if (new Set(keys).size !== keys.length) throw new LocalizedError('world.content.duplicate-content-version');
    for (const key of this.state.activePackages) if (!keys.includes(key)) throw new LocalizedError('world.content.missing-content-package', { p0: key });
    for (const value of Object.values(this.state.overrides)) if (!this.state.packages.find(p => packageKey(p) === value.package)?.assets[value.asset]) throw new LocalizedError('world.content.an-object-patch-references-a-missing-asset');
  }
  install(value: ContentPackage, activate: boolean): void {
    const pack = contentPackageSchema.parse(value), key = packageKey(pack);
    const previous = this.state.packages.find(p => packageKey(p) === key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(pack)) throw new LocalizedError('world.content.installed-versions-are-immutable-publish-a-new-version');
    if (!previous && this.state.packages.length >= 256) throw new LocalizedError('world.content.the-world-content-package-limit-has-been-reached');
    const active = activate ? [...this.state.activePackages.filter(k => !k.startsWith(`${pack.id}@`)), key] : this.state.activePackages;
    if (active.length > 16) throw new LocalizedError('world.content.no-more-than-16-content-packages-may-be-active');
    if (!previous) this.state.packages.push(pack);
    this.state.activePackages = active;
    this.state.revision++;
  }
  deployRegion(pack: ContentPackage, protectedChunks: string[], tick: number): void {
    if (!pack.region) throw new LocalizedError('world.content.missing-region-recipe');
    // Retire unbounded legacy overlays only for future generation; existing chunk pins remain intact.
    this.state.activePackages = this.state.activePackages.filter(key => {
      const previous = this.state.packages.find(p => packageKey(p) === key);
      return previous?.region || !previous?.terrain;
    });
    this.install(pack, true);
    const key = packageKey(pack);
    if (!this.state.regionalDeployments.some(d => d.package === key)) this.state.regionalDeployments.push({ package: key, protectedChunks: [...new Set(protectedChunks)].sort(), tick });
  }
  generate(cell: Hex, config: WorldConfig, record?: ChunkRecord): ChunkData {
    const pins = record ? record.contentPackages ?? [] : this.state.activePackages.filter(key => {
      const pack = this.state.packages.find(p => packageKey(p) === key)!;
      return !pack.region || regionCells(pack.region, config).some(c => hexKey(c) === hexKey(cell));
    });
    const packages = pins.map(key => {
      const p = this.state.packages.find(p => packageKey(p) === key);
      if (!p) throw new LocalizedError('world.content.a-chunk-is-missing-pinned-content-version', { p0: key });
      return p;
    });
    const chunk = generateContentChunk(cell, config, packages, this.state.regionalDeployments);
    chunk.contentPackages = pins;
    for (const asset of chunk.assets) this.applyOverride(asset);
    chunk.assets = this.materialize(chunk.assets, cell, config);
    return chunk;
  }
  materialize(base: Asset[], cell: Hex, config: WorldConfig): Asset[] {
    const deleted = new Set(this.state.deletedIds), key = hexKey(cell);
    const assets = base.filter(a => !deleted.has(a.id) && !this.state.patches[a.id]);
    for (const a of [...Object.values(this.state.additions), ...Object.values(this.state.patches)]) {
      if (deleted.has(a.id) || hexKey(worldToHex(a.x, a.z, config.chunkRadius)) !== key) continue;
      const copy = structuredClone(a); this.applyOverride(copy); assets.push(copy);
    }
    return assets.sort((a, b) => a.id.localeCompare(b.id));
  }
  applyOverride(asset: Asset): void {
    const patch = this.state.overrides[asset.id];
    if (patch) { asset.design = this.state.packages.find(p => packageKey(p) === patch.package)!.assets[patch.asset]; asset.contentKey = patch.package; }
  }
}

import * as THREE from 'three';
import type { WorldReadModel as WorldRuntime } from '../../world/src/ports/read-model';
import { nearbyProtected, regionKey, regionWeight } from '../../world/src/regions';
import { randomAt } from '../../world/src/random';

/** Pure observation of absolute world time. Pausing or revisiting reproduces the same particles. */
export class WorldEffects {
  readonly points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ size: 0.11, vertexColors: true, transparent: true, opacity: 0.85 }));
  private positions = new Float32Array(12000);
  private colors = new Float32Array(12000);
  private terrainState = '';
  private groundSamples = new Map<string, number>();
  constructor() {
    this.points.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.points.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3)); this.points.frustumCulled = false;
  }
  update(runtime: WorldRuntime): void {
    let count = 0;
    const terrainState = `${runtime.content.state.revision}:${[...runtime.chunks.active.keys()].sort().join('|')}`;
    if (terrainState !== this.terrainState) { this.terrainState = terrainState; this.groundSamples.clear(); }
    const ground = (key: string, x: number, z: number): number => {
      let height = this.groundSamples.get(key);
      if (height === undefined) { height = runtime.groundHeight(x, z); this.groundSamples.set(key, height); }
      return height;
    };
    const put = (x: number, y: number, z: number, rgb: number[]) => {
      if (count >= this.positions.length / 3) return;
      this.positions.set([x - runtime.origin.x, y, z - runtime.origin.z], count * 3); this.colors.set(rgb, count++ * 3);
    };
    const seconds = runtime.clock.elapsedSeconds;
    for (const a of [...runtime.chunks.assets.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (count >= this.positions.length / 3) break;
      if (a.design?.effect === 'fireflies') {
        // An object emitter follows its world-space owner, never the observing camera.
        for (let i = 0; i < 96; i++) {
          const rnd = (layer: string) => randomAt(runtime.config.seed, `${a.id}:${layer}`, i, 0);
          const baseX = a.x + (rnd('fx') - 0.5) * 9 * a.scale, baseZ = a.z + (rnd('fz') - 0.5) * 9 * a.scale;
          const x = baseX + Math.sin(seconds * 0.35 + i) * 0.4 * a.scale;
          const z = baseZ + Math.cos(seconds * 0.25 + i) * 0.4 * a.scale;
          const y = Math.max(a.y, ground(`${a.id}:firefly:${i}`, baseX, baseZ)) + (1 + rnd('fy') * 2 + Math.sin(seconds + i) * 0.3) * a.scale;
          put(x, y, z, [0.8, 1, 0.25]);
        }
      }
      if (a.design?.effect !== 'petals') continue;
      for (let i = 0; i < 120; i++) {
        const rnd = (layer: string) => randomAt(runtime.config.seed, `${a.id}:${layer}`, i, 0);
        const phase = (rnd('phase') + seconds * 0.12) % 1;
        const x = a.x + (rnd('x') - 0.5) * 9 * a.scale + (i < 65 ? Math.sin(seconds * 0.4 + i) * phase : 0);
        const z = a.z + (rnd('z') - 0.5) * 9 * a.scale;
        const y = i < 65 ? a.y + 7 * a.scale * (1 - phase) : ground(`${a.id}:petal:${i}`, x, z) + 0.06;
        put(x, y, z, [1, 0.49 + rnd('shade') * 0.25, 0.72]);
      }
    }
    for (const p of [...runtime.content.weatherPackages, ...runtime.content.regionalWeather(runtime.chunks.active.values())]) if (p.weather) {
      for (const cell of [...runtime.chunks.active.values()].sort((a, b) => a.key.localeCompare(b.key))) {
        if (p.region && !cell.contentPackages?.includes(regionKey(p))) continue;
        const protectedCells = p.region ? nearbyProtected(runtime.content.state.regionalDeployments.find(d => d.package === regionKey(p)), cell.cell) : [];
        const seed = `${runtime.config.seed}:${p.id}@${p.version}:${cell.key}`;
        for (let i = 0; i < Math.round(160 * p.weather.density); i++) {
          if (count >= this.positions.length / 3) break;
          // Uniform samples in a hex fan: stable per chunk, including shared loaded ranges.
          const side = Math.floor(randomAt(seed, 'side', i, 0) * 6), angle = Math.PI / 6 + side * Math.PI / 3;
          const u = Math.sqrt(randomAt(seed, 'radius', i, 0)), v = randomAt(seed, 'edge', i, 0), radius = runtime.config.chunkRadius;
          const x = cell.center.x + u * radius * ((1 - v) * Math.cos(angle) + v * Math.cos(angle + Math.PI / 3));
          const z = cell.center.z + u * radius * ((1 - v) * Math.sin(angle) + v * Math.sin(angle + Math.PI / 3));
          if (p.region && regionWeight(p.region, x, z, protectedCells, runtime.config) < 0.1) continue;
          const phase = (randomAt(seed, 'height', i, 0) + seconds * 0.06) % 1;
          const y = ground(`${seed}:${i}`, x, z) + (p.weather.kind === 'snow' ? (1 - phase) * 25 : 1 + Math.sin(seconds + i) * 0.5);
          put(x, y, z, p.weather.kind === 'snow' ? [0.96, 0.98, 1] : [0.8, 1, 0.25]);
        }
      }
    }
    this.points.geometry.setDrawRange(0, count);
    this.points.geometry.attributes.position.needsUpdate = true; this.points.geometry.attributes.color.needsUpdate = true;
  }
  dispose(): void { this.points.geometry.dispose(); this.points.material.dispose(); }
}

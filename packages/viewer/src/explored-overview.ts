import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { WorldReadModel as WorldRuntime } from "../../world/src/ports/read-model";
import type { ChunkData } from "../../world/src/generator";
import { hexCenter, hexKey } from "../../world/src/hex";
import { PALETTE } from "../../protocol/src/config";
import {
  ByteCache,
  type OverviewLOD,
  type OverviewMesh,
  type OverviewSummary,
} from "./overview-data";

/** An independent, visual-only world. It never generates physics chunks or changes exploration records. */
export class ExploredOverview {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000);
  readonly controls: OrbitControls;
  readonly renderer: THREE.WebGLRenderer;
  followCamera = false;
  fitAll = true;
  private origin = { x: 0, z: 0 };
  private summaries = new Map<string, OverviewSummary>();
  private bounds = new THREE.Box3();
  private pointIndex = new Map<string, number>();
  private pointUpdates = new Set<string>();
  private pointsNeedRebase = true;
  private pointCapacity = 0;
  private born = new Map<string, number>();
  private worker = new Worker(
    new URL("./overview.worker.ts", import.meta.url),
    { type: "module" },
  );
  private ready: OverviewMesh[] = [];
  private waiting = new Set<string>();
  private wanted = new Map<string, OverviewLOD>();
  private selected: OverviewSummary[] = [];
  private cache: ByteCache<THREE.Mesh>;
  private meshMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  private coarseGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
  private coarseMaterial = new THREE.MeshStandardMaterial({
    flatShading: true,
    roughness: 1,
  });
  private coarse?: THREE.InstancedMesh;
  private coarseCapacity = 0;
  private points = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({
      size: 2,
      sizeAttenuation: false,
      vertexColors: true,
    }),
  );
  private trail = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: PALETTE.trail, depthTest: false }),
  );
  private marker = new THREE.Mesh(
    new THREE.ConeGeometry(1, 3, 3),
    new THREE.MeshBasicMaterial({ color: PALETTE.player }),
  );
  private dynamics = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial({ color: "#b98c57" }),
    512,
  );
  private traffic = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.8, 1.5, 3.6),
    new THREE.MeshLambertMaterial({ color: "#b9493c" }),
    128,
  );
  private ambient = new THREE.HemisphereLight("#eef5ed", "#8f9b75", 2.5);
  private sun = new THREE.DirectionalLight("#fff5d8", 2.5);
  private dirty = true;
  private pointsDirty = true;
  private lastRender = -Infinity;
  private lastPlan = -Infinity;
  private animatedUntil = 0;
  private lastPosition: { x: number; z: number };
  private trailLength = -1;
  private lastConfig = "";
  private unsubscribe: () => void;
  private frameMs = 0;
  private renderCount = 0;
  private disposed = false;
  private workerError = "";
  private contentRevision = -1;

  constructor(
    readonly runtime: WorldRuntime,
    readonly canvas: HTMLCanvasElement,
  ) {
    // Even the cheapest mesh follows six sampled corner elevations instead of showing flat steps.
    this.coarseMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = `attribute vec4 terrainHeightsA;\nattribute vec4 terrainHeightsB;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        `
        #include <begin_vertex>
        if (position.y > 0.0) {
          float corner = mod(floor((atan(position.z, position.x) - 0.5235987755982988) / 1.0471975511965976 + 0.5) + 6.0, 6.0);
          float h = corner < 0.5 ? terrainHeightsA.y : corner < 1.5 ? terrainHeightsA.z : corner < 2.5 ? terrainHeightsA.w
            : corner < 3.5 ? terrainHeightsB.x : corner < 4.5 ? terrainHeightsB.y : terrainHeightsB.z;
          transformed.y = length(position.xz) < 0.1 ? terrainHeightsA.x : h;
        } else { transformed.y = terrainHeightsB.w; }
      `,
      );
    };
    this.coarseMaterial.customProgramCacheKey = () => "overview-sloped-hex";
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "low-power",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.scene.background = new THREE.Color(PALETTE.background);
    this.dynamics.count = 0;
    this.dynamics.frustumCulled = false;
    this.traffic.count = 0;
    this.traffic.frustumCulled = false;
    this.scene.add(
      this.ambient,
      this.sun,
      this.points,
      this.trail,
      this.marker,
      this.dynamics,
      this.traffic,
    );
    this.sun.position.set(80, 140, 60);
    this.points.frustumCulled = false;
    this.trail.renderOrder = 10;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.14;
    this.controls.minDistance = runtime.config.chunkRadius * 0.5;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.addEventListener("start", () => {
      this.fitAll = false;
      this.followCamera = false;
    });
    this.controls.addEventListener("change", () => (this.dirty = true));
    this.cache = new ByteCache(this.cacheLimit, (mesh) => {
      mesh.removeFromParent();
      mesh.geometry.dispose();
    });
    this.lastPosition = { x: runtime.camera.x, z: runtime.camera.z };
    this.worker.onmessage = (event) => {
      if (this.disposed) return;
      if (event.data.type === "summaries") {
        for (const summary of event.data.summaries as OverviewSummary[]) {
          const previous = this.summaries.get(summary.key);
          if (previous) {
            const top = Math.max(previous.top, summary.top);
            this.summaries.set(summary.key, { ...summary, top });
            this.pointUpdates.add(summary.key);
            this.bounds.max.y = Math.max(
              this.bounds.max.y,
              top + runtime.config.population.treeHeight,
            );
          }
        }
        this.pointsDirty = true;
        this.dirty = true;
      } else if (event.data.type === "mesh") {
        if (event.data.revision !== this.runtime.content.state.revision) {
          this.worker.postMessage({
            type: "uploaded",
            revision: event.data.revision,
          });
          return;
        }
        const mesh = event.data.mesh as OverviewMesh;
        this.waiting.delete(`${mesh.key}:${mesh.lod}`);
        // Keep completed transfers bounded even if the window is temporarily not rendering.
        if (!this.cache.entries.has(`${mesh.key}:${mesh.lod}`))
          this.ready.push(mesh);
        else
          this.worker.postMessage({
            type: "uploaded",
            revision: event.data.revision,
          });
      } else {
        this.workerError = event.data.message;
        this.waiting.clear();
      }
    };
    this.worker.onerror = (event) => {
      this.workerError = event.message;
      this.waiting.clear();
    };
    this.worker.postMessage({
      type: "init",
      config: structuredClone(runtime.config),
    });
    const active = runtime.chunks.active;
    this.register(
      [...runtime.chunks.records.values()]
        .filter((record) => record.visits > 0)
        .map((record) => active.get(hexKey(record)) ?? record),
    );
    this.unsubscribe = runtime.subscribe((change) =>
      this.register(change.added),
    );
    this.reset();
    this.resize();
  }

  private get cacheLimit(): number {
    return this.runtime.config.presentation.overviewCacheMB * 1024 * 1024;
  }

  private register(records: ({ q: number; r: number } | ChunkData)[]): void {
    this.updateContent(
      records
        .map(
          (r) =>
            this.runtime.chunks.records.get(hexKey("cell" in r ? r.cell : r))!,
        )
        .filter(Boolean),
    );
    const cells = [],
      now = performance.now() / 1000;
    for (const record of records) {
      const cell = "cell" in record ? record.cell : record,
        key = hexKey(cell);
      if (this.summaries.has(key)) continue;
      const center = hexCenter(cell, this.runtime.config.chunkRadius);
      let top = 0,
        height = 0,
        color = [0.3, 0.42, 0.2],
        corners = [0, 0, 0, 0, 0, 0];
      if ("positions" in record) {
        height = record.positions[1];
        color = Array.from(record.colors.slice(0, 3));
        corners = record.boundary
          .filter((_, index) => index % this.runtime.config.subdivisions === 0)
          .map((point) => point.y);
        for (let i = 1; i < record.positions.length; i += 3)
          top = Math.max(top, record.positions[i]);
      }
      this.pointIndex.set(key, this.summaries.size);
      this.pointUpdates.add(key);
      this.summaries.set(key, {
        key,
        cell,
        center,
        height,
        top,
        color,
        corners,
      });
      cells.push(cell);
      const radius = this.runtime.config.chunkRadius;
      this.bounds.expandByPoint(
        new THREE.Vector3(
          center.x - radius,
          -this.runtime.config.terrain.columnDepth,
          center.z - radius,
        ),
      );
      this.bounds.expandByPoint(
        new THREE.Vector3(
          center.x + radius,
          top + this.runtime.config.population.treeHeight,
          center.z + radius,
        ),
      );
      const saved = this.runtime.chunks.records.get(key)!;
      const fresh =
        saved.visits === 1 && saved.firstTick === this.runtime.clock.tick;
      this.born.set(
        key,
        fresh ? now : now - this.runtime.config.presentation.animationDuration,
      );
    }
    if (cells.length) {
      this.worker.postMessage({ type: "summaries", cells });
      this.pointsDirty = true;
      this.dirty = true;
      this.animatedUntil =
        now + this.runtime.config.presentation.animationDuration;
      if (this.fitAll) this.fit();
    }
  }

  private updateContent(
    records: import("../../protocol/src/contracts").ChunkRecord[] = [],
  ): void {
    const revision = this.runtime.content.state.revision;
    if (revision !== this.contentRevision) {
      this.contentRevision = revision;
      this.cache.clear();
      this.ready = [];
      this.waiting.clear();
      this.dirty = true;
      this.lastPlan = -Infinity;
      this.worker.postMessage({
        type: "content",
        state: structuredClone(this.runtime.content.state),
        records: [...this.runtime.chunks.records.values()],
      });
    } else if (records.length) {
      this.worker.postMessage({ type: "records", records });
    }
  }

  reset(): void {
    this.fitAll = true;
    this.followCamera = false;
    this.fit();
  }

  private fit(): void {
    if (!this.summaries.size) return;
    const radius = this.runtime.config.chunkRadius;
    const bounds = this.bounds;
    const center = bounds.getCenter(new THREE.Vector3());
    this.rebase(center.x, center.z);
    const target = new THREE.Vector3(0, center.y, 0);
    const direction = new THREE.Vector3(1.1, 1.4, 1.3).normalize();
    const right = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), direction)
      .normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)),
      tanX = tanY * this.camera.aspect;
    let distance = radius;
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          const relative = new THREE.Vector3(
              x - center.x,
              y - center.y,
              z - center.z,
            ),
            depth = relative.dot(direction);
          distance = Math.max(
            distance,
            depth + (Math.abs(relative.dot(right)) * 1.05) / tanX,
            depth + (Math.abs(relative.dot(up)) * 1.05) / tanY,
          );
        }
    this.controls.target.copy(target);
    this.camera.position.copy(target).add(direction.multiplyScalar(distance));
    this.controls.maxDistance = Math.max(radius * 80, distance * 6);
    this.camera.far = Math.max(5000, distance * 8);
    this.camera.near = Math.max(0.1, distance * 0.00001);
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(target);
    this.controls.update();
    this.dirty = true;
  }

  private rebase(x: number, z: number): void {
    const dx = x - this.origin.x,
      dz = z - this.origin.z;
    if (!dx && !dz) return;
    this.camera.position.x -= dx;
    this.camera.position.z -= dz;
    this.controls.target.x -= dx;
    this.controls.target.z -= dz;
    this.origin = { x, z };
    this.pointsDirty = true;
    this.pointsNeedRebase = true;
    this.trailLength = -1;
    this.dirty = true;
  }

  resize(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.renderer.setPixelRatio(
      Math.min(
        devicePixelRatio,
        this.runtime.config.presentation.overviewPixelRatio,
      ),
    );
    this.renderer.setSize(rect.width, rect.height, false);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
    if (this.fitAll) this.fit();
    this.dirty = true;
  }

  private plan(): void {
    const radius = this.runtime.config.chunkRadius,
      budget = this.runtime.config.presentation.overviewDetailChunks;
    const focal =
      this.canvas.clientHeight /
      (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.camera.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        this.camera.projectionMatrix,
        this.camera.matrixWorldInverse,
      ),
    );
    const candidates: { data: OverviewSummary; pixels: number }[] = [];
    const sphere = new THREE.Sphere(),
      point = new THREE.Vector3();
    for (const data of this.summaries.values()) {
      point.set(
        data.center.x - this.origin.x,
        data.height,
        data.center.z - this.origin.z,
      );
      sphere.set(
        point,
        Math.hypot(
          radius,
          data.top - data.height + this.runtime.config.terrain.columnDepth,
        ),
      );
      if (!frustum.intersectsSphere(sphere)) continue;
      candidates.push({
        data,
        pixels:
          (radius * focal) /
          Math.max(radius, point.distanceTo(this.camera.position)),
      });
    }
    candidates.sort((a, b) => b.pixels - a.pixels);
    this.selected = candidates
      .slice(0, budget * 8)
      .filter((item) => item.pixels >= 2)
      .map((item) => item.data);
    this.wanted.clear();
    for (const { data, pixels } of candidates) {
      if (this.wanted.size >= budget || pixels < 3) break;
      this.wanted.set(data.key, pixels >= 24 ? "detail" : "surface");
    }
    this.cache.limit = this.cacheLimit;
    this.cache.trim();
    const queued = new Set(this.ready.map((mesh) => `${mesh.key}:${mesh.lod}`));
    const jobs = [];
    this.waiting.clear();
    for (const [key, lod] of this.wanted) {
      const id = `${key}:${lod}`;
      if (!this.cache.get(id) && !queued.has(id) && !this.workerError) {
        jobs.push({ cell: this.summaries.get(key)!.cell, lod });
        this.waiting.add(id);
      }
    }
    this.worker.postMessage({ type: "plan", jobs });
    this.syncMeshes();
    this.rebuildBase();
  }

  private syncMeshes(): void {
    for (const [id, entry] of this.cache.entries) {
      const key = id.slice(0, id.lastIndexOf(":")),
        lod = id.slice(id.lastIndexOf(":") + 1);
      if (this.wanted.get(key) === lod) this.scene.add(entry.value);
      else entry.value.removeFromParent();
    }
  }

  private consume(): void {
    // One GPU upload per application frame; terrain computation stays in the worker.
    const data = this.ready.shift();
    if (!data) return;
    this.worker.postMessage({
      type: "uploaded",
      revision: this.contentRevision,
    });
    const id = `${data.key}:${data.lod}`;
    if (this.cache.entries.has(id) || !this.summaries.has(data.key)) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(data.positions, 3),
    );
    geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, this.meshMaterial);
    mesh.name = `overview:${id}`;
    this.cache.set(
      id,
      mesh,
      data.positions.byteLength +
        data.normals.byteLength +
        data.colors.byteLength,
    );
    this.syncMeshes();
    this.rebuildBase();
    this.dirty = true;
  }

  private rebuildBase(): void {
    const entries = this.selected.filter((data) => {
      const lod = this.wanted.get(data.key);
      return !lod || !this.cache.entries.has(`${data.key}:${lod}`);
    });
    if (entries.length > this.coarseCapacity) {
      this.coarse?.removeFromParent();
      this.coarse?.dispose();
      this.coarseGeometry.dispose();
      this.coarseGeometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1);
      this.coarseCapacity =
        2 ** Math.ceil(Math.log2(Math.max(8, entries.length)));
      for (const name of ["terrainHeightsA", "terrainHeightsB"])
        this.coarseGeometry.setAttribute(
          name,
          new THREE.InstancedBufferAttribute(
            new Float32Array(this.coarseCapacity * 4),
            4,
          ).setUsage(THREE.DynamicDrawUsage),
        );
      this.coarse = new THREE.InstancedMesh(
        this.coarseGeometry,
        this.coarseMaterial,
        this.coarseCapacity,
      );
      this.coarse.frustumCulled = false;
      this.scene.add(this.coarse);
    }
    if (!this.coarse) return;
    const matrix = new THREE.Matrix4(),
      color = new THREE.Color(),
      radius = this.runtime.config.chunkRadius;
    const bottom = -this.runtime.config.terrain.columnDepth,
      now = performance.now() / 1000;
    const heightsA = this.coarseGeometry.getAttribute(
      "terrainHeightsA",
    ) as THREE.InstancedBufferAttribute;
    const heightsB = this.coarseGeometry.getAttribute(
      "terrainHeightsB",
    ) as THREE.InstancedBufferAttribute;
    entries.forEach((data, i) => {
      const surface = (value: number) =>
        Math.max(value, this.runtime.config.terrain.waterLevel);
      heightsA.setXYZW(
        i,
        surface(data.height),
        surface(data.corners[0]),
        surface(data.corners[1]),
        surface(data.corners[2]),
      );
      heightsB.setXYZW(
        i,
        surface(data.corners[3]),
        surface(data.corners[4]),
        surface(data.corners[5]),
        bottom,
      );
      const duration = this.runtime.config.presentation.animationDuration;
      const t =
        duration > 0
          ? Math.min(1, (now - this.born.get(data.key)!) / duration)
          : 1;
      matrix.makeScale(radius, 1, radius);
      matrix.setPosition(
        data.center.x - this.origin.x,
        -((1 - t) ** 3) * this.runtime.config.presentation.riseDistance,
        data.center.z - this.origin.z,
      );
      this.coarse!.setMatrixAt(i, matrix);
      this.coarse!.setColorAt(
        i,
        color.setRGB(data.color[0], data.color[1], data.color[2]),
      );
    });
    this.coarse.count = entries.length;
    this.coarse.instanceMatrix.needsUpdate = true;
    heightsA.needsUpdate = true;
    heightsB.needsUpdate = true;
    if (this.coarse.instanceColor) this.coarse.instanceColor.needsUpdate = true;
  }

  private rebuildPoints(): void {
    if (this.pointCapacity < this.summaries.size) {
      this.pointCapacity =
        2 ** Math.ceil(Math.log2(Math.max(8, this.summaries.size)));
      this.points.geometry.dispose();
      this.points.geometry = new THREE.BufferGeometry();
      this.points.geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(
          new Float32Array(this.pointCapacity * 3),
          3,
        ).setUsage(THREE.DynamicDrawUsage),
      );
      this.points.geometry.setAttribute(
        "color",
        new THREE.BufferAttribute(
          new Float32Array(this.pointCapacity * 3),
          3,
        ).setUsage(THREE.DynamicDrawUsage),
      );
      this.pointsNeedRebase = true;
    }
    const positions = this.points.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const colors = this.points.geometry.getAttribute(
      "color",
    ) as THREE.BufferAttribute;
    positions.clearUpdateRanges();
    colors.clearUpdateRanges();
    const keys = this.pointsNeedRebase
      ? this.summaries.keys()
      : this.pointUpdates.keys();
    for (const key of keys) {
      const data = this.summaries.get(key)!,
        index = this.pointIndex.get(key)!;
      positions.setXYZ(
        index,
        data.center.x - this.origin.x,
        data.height - 0.2,
        data.center.z - this.origin.z,
      );
      colors.setXYZ(index, data.color[0], data.color[1], data.color[2]);
      if (!this.pointsNeedRebase) {
        positions.addUpdateRange(index * 3, 3);
        colors.addUpdateRange(index * 3, 3);
      }
    }
    if (this.pointsNeedRebase) {
      positions.addUpdateRange(0, this.summaries.size * 3);
      colors.addUpdateRange(0, this.summaries.size * 3);
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.summaries.size);
    this.pointsDirty = false;
    this.pointsNeedRebase = false;
    this.pointUpdates.clear();
  }

  render(now: number, prioritizeRoaming: boolean): void {
    if (this.contentRevision !== this.runtime.content.state.revision)
      this.updateContent();
    this.consume();
    const rate =
      this.runtime.config.presentation.overviewFPS /
      (prioritizeRoaming ? 2 : 1);
    if (now - this.lastRender < 1 / rate) return;
    const started = performance.now(),
      config = this.runtime.config.presentation;
    const signature = `${config.overviewDetailChunks}:${config.overviewCacheMB}:${config.overviewPixelRatio}:${this.runtime.config.presentation.showGlobalTrail}`;
    if (signature !== this.lastConfig) {
      this.lastConfig = signature;
      this.resize();
      this.dirty = true;
    }
    if (this.followCamera) {
      this.camera.position.x += this.runtime.camera.x - this.lastPosition.x;
      this.camera.position.z += this.runtime.camera.z - this.lastPosition.z;
      this.controls.target.x += this.runtime.camera.x - this.lastPosition.x;
      this.controls.target.z += this.runtime.camera.z - this.lastPosition.z;
    }
    this.lastPosition = { x: this.runtime.camera.x, z: this.runtime.camera.z };
    if (
      Math.hypot(this.controls.target.x, this.controls.target.z) >
      this.runtime.config.chunkRadius * 1024
    ) {
      this.rebase(
        this.origin.x + this.controls.target.x,
        this.origin.z + this.controls.target.z,
      );
    }
    this.controls.update();
    if (this.dirty && now - this.lastPlan > 0.2) {
      if (this.fitAll && this.pointsDirty) this.fit();
      this.plan();
      this.lastPlan = now;
      this.dirty = false;
    }
    if (this.pointsDirty) this.rebuildPoints();
    if (now < this.animatedUntil) this.rebuildBase();
    for (const [id, entry] of this.cache.entries)
      if (entry.value.parent) {
        const key = id.slice(0, id.lastIndexOf(":")),
          data = this.summaries.get(key)!;
        const t =
          config.animationDuration > 0
            ? Math.min(
                1,
                (now - this.born.get(key)!) / config.animationDuration,
              )
            : 1;
        entry.value.position.set(
          data.center.x - this.origin.x,
          -((1 - t) ** 3) * config.riseDistance,
          data.center.z - this.origin.z,
        );
      }
    if (this.trailLength !== this.runtime.trail.length) {
      this.trailLength = this.runtime.trail.length;
      this.trail.geometry.dispose();
      this.trail.geometry = new THREE.BufferGeometry().setFromPoints(
        this.runtime.trail.map(
          (point) =>
            new THREE.Vector3(
              point.x - this.origin.x,
              point.y + 0.3,
              point.z - this.origin.z,
            ),
        ),
      );
    }
    this.trail.visible = config.showGlobalTrail;
    const scale = Math.max(
      1,
      this.camera.position.distanceTo(this.controls.target) / 180,
    );
    this.marker.scale.setScalar(scale);
    this.marker.position.set(
      this.runtime.camera.x - this.origin.x,
      this.runtime.camera.y + 2 * scale,
      this.runtime.camera.z - this.origin.z,
    );
    this.marker.rotation.set(Math.PI / 2, 0, -this.runtime.camera.yaw);
    const transform = new THREE.Object3D();
    let count = 0;
    for (const id of this.runtime.state.bodies.keys()) {
      if (count >= this.dynamics.instanceMatrix.count) break;
      const entity = this.runtime.state.entities.get(id)!;
      transform.position.set(
        entity.position.x - this.origin.x,
        entity.position.y,
        entity.position.z - this.origin.z,
      );
      transform.quaternion.set(
        entity.rotation.x,
        entity.rotation.y,
        entity.rotation.z,
        entity.rotation.w,
      );
      transform.scale.setScalar(entity.halfExtent * 2);
      transform.updateMatrix();
      this.dynamics.setMatrixAt(count++, transform.matrix);
    }
    this.dynamics.count = count;
    this.dynamics.instanceMatrix.needsUpdate = true;
    const day = Math.max(
      0,
      Math.sin(((this.runtime.clock.hour - 6) / 24) * Math.PI * 2),
    );
    this.sun.intensity = 0.08 + day * 2.4;
    this.ambient.intensity = 0.35 + day * 2.15;
    this.sun.position
      .copy(this.controls.target)
      .add(new THREE.Vector3(80, 140, 60));
    this.sun.target.position.copy(this.controls.target);
    this.scene.add(this.sun.target);
    let cars = 0;
    const vehicle = new THREE.Object3D();
    for (const asset of this.runtime.traffic.assets.values()) {
      if (cars >= 128) break;
      vehicle.position.set(
        asset.x - this.origin.x,
        asset.y + 0.75,
        asset.z - this.origin.z,
      );
      vehicle.rotation.y = asset.rotation;
      vehicle.updateMatrix();
      this.traffic.setMatrixAt(cars++, vehicle.matrix);
    }
    this.traffic.count = cars;
    this.traffic.instanceMatrix.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    this.lastRender = now;
    this.renderCount++;
    this.frameMs = performance.now() - started;
    this.canvas.dataset.exploredChunks = String(this.summaries.size);
    this.canvas.dataset.detailChunks = String(
      [...this.cache.entries.values()].filter((entry) =>
        Boolean(entry.value.parent),
      ).length,
    );
    this.canvas.dataset.cacheBytes = String(this.cache.bytes);
  }

  stats() {
    return {
      source: "explored",
      exploredChunks: this.summaries.size,
      physicsChunks: this.runtime.chunks.active.size,
      visibleTerrainChunks: [...this.cache.entries.values()].filter((entry) =>
        Boolean(entry.value.parent),
      ).length,
      baseChunks: this.coarse?.count ?? 0,
      pointChunks: this.summaries.size,
      cacheBytes: this.cache.bytes,
      cacheLimitBytes: this.cacheLimit,
      cacheHits: this.cache.hits,
      cachedMeshes: this.cache.entries.size,
      pending: this.waiting.size + this.ready.length + Number(this.dirty),
      frameMs: this.frameMs,
      renderCount: this.renderCount,
      fitAll: this.fitAll,
      workerError: this.workerError,
      detailKeys: [...this.wanted]
        .filter(([key, lod]) => this.cache.entries.has(`${key}:${lod}`))
        .map(([key]) => key),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    this.unsubscribe();
    this.controls.dispose();
    this.cache.clear();
    this.coarse?.dispose();
    this.coarseGeometry.dispose();
    this.coarseMaterial.dispose();
    this.meshMaterial.dispose();
    this.dynamics.dispose();
    this.dynamics.geometry.dispose();
    this.traffic.geometry.dispose();
    (this.traffic.material as THREE.Material).dispose();
    (this.dynamics.material as THREE.Material).dispose();
    for (const object of [this.points, this.trail, this.marker]) {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
    this.renderer.dispose();
  }
}

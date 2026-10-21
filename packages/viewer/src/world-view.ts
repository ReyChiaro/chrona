import { hexKey, worldToHex } from "../../world/src/hex";
import * as THREE from "three";
import { ExploredOverview } from "./explored-overview";
import { PALETTE } from "../../protocol/src/config";
import type { Observation } from "../../protocol/src/contracts";
import type { WorldReadModel as WorldRuntime } from "../../world/src/ports/read-model";
import { createAssetVisual } from "./assets";
import {
  createChunkVisual,
  disposeGroup,
  type ChunkVisual,
} from "./chunk-visual";
import { VegetationView, isVegetation } from "./vegetation";
import { WorldEffects } from "./world-effects";
import { collectContext, type ContextBudget } from "./context-buffer";
import { pickScene } from "./selection";
import type { SceneSelection } from "../../protocol/src/content";

export class WorldView {
  readonly scene = new THREE.Scene();
  readonly overview: ExploredOverview;
  readonly firstRenderer: THREE.WebGLRenderer;
  readonly firstCamera = new THREE.PerspectiveCamera(72, 1, 0.08, 3000);
  get followCamera(): boolean {
    return this.overview.followCamera;
  }
  set followCamera(value: boolean) {
    this.overview.followCamera = value;
  }
  get fitExplored(): boolean {
    return this.overview.fitAll;
  }
  set fitExplored(value: boolean) {
    this.overview.fitAll = value;
  }
  private visuals = new Map<string, ChunkVisual>();
  private pendingVisuals = new Map<string, import("../../world/src/generator").ChunkData>();
  private chunkBuilds = 0;
  private assets = new Map<
    string,
    {
      group: THREE.Group;
      asset: import("../../world/src/generator").Asset;
      bornAt: number;
    }
  >();
  private vegetation = new VegetationView();
  private effects = new WorldEffects();
  private dynamicVisuals = new Map<string, THREE.Mesh>();
  private vehicleVisuals = new Map<string, THREE.Group>();
  private sun = new THREE.DirectionalLight("#fff5d8", 2.5);
  private ambient = new THREE.HemisphereLight("#eef5ed", "#8f9b75", 2.5);
  private unsubscribe: () => void;
  private resizeObserver: ResizeObserver;
  private renderedAt?: number;
  private recording?: {
    renderer: THREE.WebGLRenderer;
    camera: THREE.PerspectiveCamera;
  };
  selection: SceneSelection | null = null;
  private selectionBox = new THREE.Box3Helper(new THREE.Box3(), "#f4bd79");
  private anchor = new THREE.Mesh(
    new THREE.RingGeometry(0.35, 0.55, 32),
    new THREE.MeshBasicMaterial({
      color: "#ffbc74",
      side: THREE.DoubleSide,
      depthTest: false,
    }),
  );

  constructor(
    readonly runtime: WorldRuntime,
    globalCanvas: HTMLCanvasElement,
    firstCanvas: HTMLCanvasElement,
  ) {
    this.firstRenderer = this.makeRenderer(firstCanvas);
    this.scene.background = new THREE.Color(PALETTE.background);
    this.scene.add(
      this.ambient,
      this.sun,
      this.vegetation.group,
      this.effects.points,
    );
    this.selectionBox.layers.set(1);
    this.anchor.layers.set(1);
    this.anchor.rotation.x = -Math.PI / 2;
    this.selectionBox.visible = this.anchor.visible = false;
    this.scene.add(this.selectionBox, this.anchor);
    this.firstCamera.layers.enable(1);
    this.sun.position.set(70, 110, 45);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.14;
    this.scene.add(this.sun.target);
    this.unsubscribe = runtime.subscribe((change) =>
      this.sync(change.added, change.removed),
    );
    this.sync([...runtime.chunks.active.values()], []);
    this.flushChunks(Infinity, Infinity);
    this.overview = new ExploredOverview(runtime, globalCanvas);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(globalCanvas.parentElement!);
    this.resizeObserver.observe(firstCanvas.parentElement!);
    this.resize();
  }

  private makeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(
      Math.min(
        devicePixelRatio,
        this.runtime.config.presentation.pixelRatioLimit,
      ),
    );
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    return renderer;
  }

  private sync(
    added: import("../../world/src/generator").ChunkData[],
    removed: string[],
  ): void {
    for (const key of removed) {
      this.pendingVisuals.delete(key);
      const visual = this.visuals.get(key);
      if (visual) disposeGroup(visual.group);
      this.visuals.delete(key);
    }
    for (const data of added) {
      if (this.visuals.get(data.key)?.data.fingerprint !== data.fingerprint)
        this.pendingVisuals.set(data.key, data);
    }
    const now = performance.now() / 1000;
    const active = this.runtime.chunks.assets;
    for (const [id, visual] of this.assets) {
      if (
        !active.has(id) ||
        visual.group.userData.signature !== JSON.stringify(active.get(id))
      ) {
        disposeGroup(visual.group);
        this.assets.delete(id);
      }
    }
    this.vegetation.sync(
      [...active.values()].filter(isVegetation),
      this.runtime.config,
      now,
    );
    this.scene.add(this.vegetation.group);
    for (const [id, asset] of active) {
      if (isVegetation(asset)) continue;
      if (this.assets.has(id)) continue;
      const group = createAssetVisual(asset, this.runtime.config);
      group.userData.contentKey = asset.contentKey;
      group.userData.objectId = id;
      group.userData.signature = JSON.stringify(asset);
      this.assets.set(id, { group, asset, bornAt: now });
      this.scene.add(group);
    }
  }

  private flushChunks(limit = 1, budgetMs = 3): void {
    const started = performance.now();
    let built = 0;
    for (const [key, data] of this.pendingVisuals) {
      if (built >= limit || (built > 0 && performance.now() - started >= budgetMs)) break;
      this.pendingVisuals.delete(key);
      const previous = this.visuals.get(key);
      if (previous) disposeGroup(previous.group);
      const visual = createChunkVisual(data, this.runtime.config, performance.now() / 1000);
      for (const material of visual.materials)
        if (material instanceof THREE.LineBasicMaterial) material.opacity = 0.24;
      this.visuals.set(key, visual);
      this.scene.add(visual.group);
      this.chunkBuilds++;
      built++;
    }
  }

  resetOverview(): void {
    this.overview.reset();
  }

  overviewStats() {
    return { ...this.overview.stats(), chunkBuilds: this.chunkBuilds, pendingVisuals: this.pendingVisuals.size };
  }

  resize(): void {
    const rect =
      this.firstRenderer.domElement.parentElement!.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this.firstRenderer.setSize(rect.width, rect.height, false);
      this.firstCamera.aspect = rect.width / rect.height;
      this.firstCamera.updateProjectionMatrix();
    }
    this.overview.resize();
  }

  render(now: number): void {
    this.renderedAt = now;
    this.flushChunks();
    const runtime = this.runtime,
      origin = runtime.origin,
      camera = runtime.presentationCamera?.(now * 1000) ?? runtime.camera;
    const position = new THREE.Vector3(
      camera.x - origin.x,
      camera.y,
      camera.z - origin.z,
    );
    const day = Math.max(
      0,
      Math.sin(((runtime.clock.hour - 6) / 24) * Math.PI * 2),
    );
    this.sun.intensity = 0.08 + day * 2.4;
    this.ambient.intensity = 0.35 + day * 2.15;
    const sunAngle = ((runtime.clock.hour - 6) / 24) * Math.PI * 2;
    this.sun.position
      .copy(position)
      .add(
        new THREE.Vector3(
          Math.cos(sunAngle) * 100,
          Math.max(8, Math.sin(sunAngle) * 120),
          45,
        ),
      );
    this.sun.target.position.copy(position);
    const shadowSpan =
      runtime.config.chunkRadius * runtime.config.loadRange * 2;
    Object.assign(this.sun.shadow.camera, {
      left: -shadowSpan,
      right: shadowSpan,
      top: shadowSpan,
      bottom: -shadowSpan,
      far: shadowSpan * 5,
    });
    this.sun.shadow.camera.updateProjectionMatrix();

    for (const visual of this.visuals.values()) {
      visual.group.position.set(
        visual.data.center.x - origin.x,
        0,
        visual.data.center.z - origin.z,
      );
      visual.group.getObjectByName("hex-edges")!.visible =
        runtime.config.presentation.showHexEdges;
    }
    for (const { group, asset } of this.assets.values())
      group.position.set(asset.x - origin.x, asset.y, asset.z - origin.z);
    this.vegetation.update(origin, runtime.config, now, false);
    this.updateDynamicObjects();
    this.updateVehicles();
    this.effects.update(runtime);
    const far =
      runtime.config.chunkRadius * Math.max(2, runtime.config.loadRange) * 2;
    const sky = new THREE.Color("#182c42").lerp(
      new THREE.Color(PALETTE.sky),
      Math.sqrt(day),
    );
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, far * 0.55, far);
    this.firstCamera.fov = runtime.config.presentation.fieldOfView;
    this.firstCamera.far = far * 2;
    this.firstCamera.updateProjectionMatrix();
    this.firstCamera.position.copy(position);
    this.firstCamera.rotation.set(
      camera.pitch,
      camera.yaw,
      0,
      "YXZ",
    );
    this.updateSelection();
    this.firstRenderer.render(this.scene, this.firstCamera);
    this.overview.render(
      now,
      Boolean(
        this.recording ||
        document.pointerLockElement === this.firstRenderer.domElement,
      ),
    );
  }

  renderRecording(): void {
    if (this.recording) {
      const { renderer, camera } = this.recording;
      camera.copy(this.firstCamera);
      camera.layers.set(0);
      camera.aspect = renderer.domElement.width / renderer.domElement.height;
      camera.updateProjectionMatrix();
      this.visuals.forEach(
        (visual) =>
          (visual.group.getObjectByName("hex-edges")!.visible = false),
      );
      renderer.render(this.scene, camera);
    }
  }

  beginRecording(width: number, height: number): HTMLCanvasElement {
    this.endRecording();
    const renderer = this.makeRenderer(document.createElement("canvas"));
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    this.recording = { renderer, camera: this.firstCamera.clone() };
    this.renderRecording();
    return renderer.domElement;
  }

  private displayed(x: number, z: number): boolean {
    return this.runtime.chunks.active.has(
      hexKey(worldToHex(x, z, this.runtime.config.chunkRadius)),
    );
  }
  private updateDynamicObjects(): void {
    for (const [id, mesh] of this.dynamicVisuals) {
      const position = this.runtime.state.entities.get(id)?.position;
      if (
        !this.runtime.state.bodies.has(id) ||
        !position ||
        !this.displayed(position.x, position.z)
      ) {
        disposeGroup(mesh);
        this.dynamicVisuals.delete(id);
      }
    }
    for (const id of this.runtime.state.bodies.keys()) {
      const entity = this.runtime.state.entities.get(id)!;
      if (!this.displayed(entity.position.x, entity.position.z)) continue;
      let mesh = this.dynamicVisuals.get(id);
      if (!mesh) {
        const size = entity.halfExtent * 2;
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(size, size, size),
          new THREE.MeshStandardMaterial({
            color: "#b98c57",
            roughness: 0.85,
            flatShading: true,
          }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = id;
        mesh.userData.objectId = id;
        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({ color: "#73583e" }),
        );
        mesh.add(edges);
        this.dynamicVisuals.set(id, mesh);
        this.scene.add(mesh);
      }
      mesh.position.set(
        entity.position.x - this.runtime.origin.x,
        entity.position.y,
        entity.position.z - this.runtime.origin.z,
      );
      mesh.quaternion.set(
        entity.rotation.x,
        entity.rotation.y,
        entity.rotation.z,
        entity.rotation.w,
      );
    }
  }
  private updateVehicles(): void {
    const active = new Map(
      [...this.runtime.traffic.assets].filter(([, asset]) =>
        this.displayed(asset.x, asset.z),
      ),
    );
    for (const [id, group] of this.vehicleVisuals)
      if (!active.has(id)) {
        disposeGroup(group);
        this.vehicleVisuals.delete(id);
      }
    for (const [id, asset] of active) {
      let group = this.vehicleVisuals.get(id);
      if (!group) {
        group = createAssetVisual(asset, this.runtime.config);
        group.userData.objectId = id;
        this.vehicleVisuals.set(id, group);
        this.scene.add(group);
      }
      group.position.set(
        asset.x - this.runtime.origin.x,
        asset.y,
        asset.z - this.runtime.origin.z,
      );
      group.rotation.y = asset.rotation;
    }
  }

  recordingObservation(): Observation {
    const observation = this.runtime.observation();
    const { renderer, camera } = this.recording!;
    observation.camera = this.displayedCamera(camera);
    observation.viewport = {
      width: renderer.domElement.width,
      height: renderer.domElement.height,
      projectionMatrix: camera.projectionMatrix.toArray(),
      cameraMatrix: camera.matrixWorld.toArray(),
    };
    return observation;
  }

  context(time = 0, budgets?: ContextBudget) {
    return collectContext(
      this.runtime,
      this.recording?.camera ?? this.firstCamera,
      time,
      budgets,
    );
  }

  pick(clientX?: number, clientY?: number): SceneSelection | null {
    const rect = this.firstRenderer.domElement.getBoundingClientRect();
    const ndc =
      clientX === undefined
        ? new THREE.Vector2()
        : new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            (-(clientY! - rect.top) / rect.height) * 2 + 1,
          );
    this.scene.updateMatrixWorld(true);
    return pickScene(
      this.runtime,
      this.firstCamera,
      [
        ...[...this.visuals.values()].map((v) => v.group),
        this.vegetation.group,
        ...[...this.assets.values()].map((v) => v.group),
        ...this.dynamicVisuals.values(),
        ...this.vehicleVisuals.values(),
      ],
      ndc,
    );
  }
  select(value: SceneSelection | null): void {
    this.selection = value ? structuredClone(value) : null;
    this.updateSelection();
  }
  private updateSelection(): void {
    this.selectionBox.visible = this.anchor.visible = false;
    const selected = this.selection;
    if (!selected) return;
    if (selected.kind === "ground") {
      this.anchor.visible = true;
      this.anchor.position.set(
        selected.point.x - this.runtime.origin.x,
        selected.point.y + 0.04,
        selected.point.z - this.runtime.origin.z,
      );
      return;
    }
    const id = selected.objectId!,
      asset = this.runtime.sceneAssets.get(id),
      dynamic = this.runtime.state.entities.get(id);
    if (!asset && !this.runtime.state.bodies.has(id)) return;
    if (asset) {
      const visual = this.assets.get(id)?.group ?? this.vehicleVisuals.get(id);
      if (visual) {
        visual.updateMatrixWorld(true);
        this.selectionBox.box.setFromObject(visual);
      } else {
        const height = ["pine", "birch"].includes(asset.kind)
          ? this.runtime.config.population.treeHeight * asset.scale * 1.2
          : 2 * asset.scale;
        this.selectionBox.box.setFromCenterAndSize(
          new THREE.Vector3(
            asset.x - this.runtime.origin.x,
            asset.y + height / 2,
            asset.z - this.runtime.origin.z,
          ),
          new THREE.Vector3(height * 0.65, height, height * 0.65),
        );
      }
    } else
      this.selectionBox.box.setFromCenterAndSize(
        new THREE.Vector3(
          dynamic!.position.x - this.runtime.origin.x,
          dynamic!.position.y,
          dynamic!.position.z - this.runtime.origin.z,
        ),
        new THREE.Vector3().setScalar(dynamic!.halfExtent * 2),
      );
    this.selectionBox.visible = true;
  }

  endRecording(): void {
    if (!this.recording) return;
    this.recording.renderer.dispose();
    this.recording.renderer.forceContextLoss();
    this.recording = undefined;
  }

  observation(): Observation {
    const observation = this.runtime.observation();
    observation.camera = this.displayedCamera(this.firstCamera);
    observation.viewport = {
      width: this.firstRenderer.domElement.width,
      height: this.firstRenderer.domElement.height,
      projectionMatrix: this.firstCamera.projectionMatrix.toArray(),
      cameraMatrix: this.firstCamera.matrixWorld.toArray(),
    };
    return observation;
  }

  private displayedCamera(camera: THREE.PerspectiveCamera) {
    return {
      x: camera.position.x + this.runtime.origin.x,
      y: camera.position.y,
      z: camera.position.z + this.runtime.origin.z,
      yaw: camera.rotation.y,
      pitch: camera.rotation.x,
    };
  }

  capture(): { observation: Observation; image: string } {
    this.flushChunks(Infinity, Infinity);
    this.render(this.renderedAt ?? performance.now() / 1000);
    this.firstCamera.layers.disable(1);
    this.firstRenderer.render(this.scene, this.firstCamera);
    const image = this.firstRenderer.domElement.toDataURL("image/png");
    this.firstCamera.layers.enable(1);
    return { observation: this.observation(), image };
  }

  dispose(): void {
    this.pendingVisuals.clear();
    this.endRecording();
    this.unsubscribe();
    this.resizeObserver.disconnect();
    this.overview.dispose();
    for (const visual of this.visuals.values()) disposeGroup(visual.group);
    for (const visual of this.assets.values()) disposeGroup(visual.group);
    this.vegetation.dispose();
    this.effects.dispose();
    this.selectionBox.dispose();
    this.anchor.geometry.dispose();
    this.anchor.material.dispose();
    for (const visual of this.dynamicVisuals.values()) disposeGroup(visual);
    for (const visual of this.vehicleVisuals.values()) disposeGroup(visual);
    this.sun.shadow.map?.dispose();
    this.firstRenderer.dispose();
  }
}

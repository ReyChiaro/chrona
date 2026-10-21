import { LocalizedError } from "../../../i18n/src/index";
import { msg } from "../../../i18n/src/index";
import { PHYSICS_BUILD } from "./build-info";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  GENERATOR_VERSION,
  SAVE_VERSION,
  type WorldConfig,
} from "../../../protocol/src/config";
import type {
  CameraState,
  Observation,
  TrailPoint,
  WorldSnapshot,
} from "../../../protocol/src/contracts";
import { ChunkManager, type ChunkChange } from "../../../world/src/chunks";
import { WorldClock } from "../../../world/src/clock";
import { type Asset, type ChunkData } from "../../../world/src/generator";
import { spawnPosition, terrainHeight } from "../../../world/src/terrain";
import { WorldState } from "./state";
import { WorldContent } from "../../../world/src/content";
import type {
  ContentPackage,
  ObjectConstraint,
} from "../../../protocol/src/content";
import { objectConstraintSchema } from "../../../protocol/src/content";
import { surfaceHeight } from "../../../world/src/surface";
import {
  hexKey,
  worldToHex,
  hexDisk,
  parseHexKey,
} from "../../../world/src/hex";
import { assetColliders, assetHorizontalReach } from "./asset-colliders";
import { WorldEditor } from "../../../world/src/editor";
import { RegionalTraffic } from "./traffic";

export interface MovementInput {
  forward: number;
  right: number;
  sprint: boolean;
  jump: boolean;
}
export type WorldListener = (change: ChunkChange) => void;
let physicsReady: Promise<void> | undefined;
export const initializePhysics = (): Promise<void> =>
  (physicsReady ??= RAPIER.init());

export class WorldRuntime {
  readonly chunks: ChunkManager;
  readonly clock: WorldClock;
  physics: RAPIER.World;
  readonly state: WorldState;
  readonly content: WorldContent;
  readonly editor: WorldEditor;
  readonly traffic: RegionalTraffic;
  get sceneAssets(): Map<string, Asset> {
    return new Map([...this.chunks.assets, ...this.traffic.assets]);
  }
  readonly origin = { x: 0, z: 0 };
  readonly camera: CameraState;
  readonly trail: TrailPoint[] = [];
  readonly events: import("../../../protocol/src/contracts").WorldEvent[] = [];
  readonly id: string;
  name: string;
  grounded = false;
  private player: RAPIER.RigidBody;
  private playerCollider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;
  private chunkBodies = new Map<string, RAPIER.RigidBody>();
  private assetBodies = new Map<string, RAPIER.RigidBody>();
  private listeners = new Set<WorldListener>();
  private verticalVelocity = 0;
  private accumulator = 0;
  observerTime = 0;
  stepMilliseconds = 0;
  get pendingSteps(): number {
    return Math.floor(this.accumulator * this.config.physics.frequency + 1e-8);
  }
  readonly simulationChunks = new Map<string, ChunkData>();
  readonly residencyReasons = new Map<string, Set<string>>();
  private pendingDrops: { id: string; x: number; y: number; z: number }[] = [];
  private jumpHeld = false;
  disposed = false;

  constructor(
    public config: WorldConfig,
    saved?: WorldSnapshot,
  ) {
    if (saved && !saved.execution)
      throw new LocalizedError(
        "adapters.runtime.a-complete-physics-checkpoint-is-required",
      );
    if (saved && saved.generatorVersion !== GENERATOR_VERSION)
      throw new LocalizedError(
        "adapters.runtime.the-save-generator-version-is-incompatible-with-this-runtime",
      );
    if (
      saved?.execution &&
      (saved.execution.engineVersion !== RAPIER.version() ||
        saved.execution.build !== PHYSICS_BUILD)
    )
      throw new LocalizedError(
        "adapters.runtime.the-physics-snapshot-engine-version-or-build-is-incompatible",
      );
    this.id = saved?.id ?? crypto.randomUUID();
    this.name = saved?.name ?? msg("ui.layout.cedar-valley");
    this.content = new WorldContent(saved?.content);
    this.editor = new WorldEditor(this);
    this.chunks = new ChunkManager(config, (cell, cfg, record) =>
      this.content.generate(cell, cfg, record),
    );
    this.clock = new WorldClock(config.clock);
    this.camera = { ...(saved?.camera ?? spawnPosition(config)) };
    if (saved) {
      this.clock.tick = saved.tick;
      this.clock.elapsedSeconds = saved.elapsedSeconds;
      for (const record of saved.chunks)
        this.chunks.records.set(`${record.q},${record.r}`, record);
      this.trail.push(...saved.trail);
      this.events.push(...(saved.events ?? []));
      this.clock.paused = saved.simulation.paused;
      this.verticalVelocity = saved.simulation.verticalVelocity;
      this.grounded = saved.simulation.grounded;
    }
    const shift = config.chunkRadius * config.physics.originShiftChunks;
    this.origin.x = Math.round(this.camera.x / shift) * shift;
    this.origin.z = Math.round(this.camera.z / shift) * shift;
    this.physics = new RAPIER.World({ x: 0, y: -config.physics.gravity, z: 0 });
    this.physics.timestep = 1 / config.physics.frequency;
    this.traffic = new RegionalTraffic(this.physics, this.origin, this.content);
    this.syncChunks(true);
    const halfHeight = config.physics.characterHalfHeight;
    const radius = config.physics.characterRadius;
    const eyeOffset = config.physics.eyeHeight - halfHeight - radius;
    this.player = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        this.camera.x - this.origin.x,
        this.camera.y - eyeOffset,
        this.camera.z - this.origin.z,
      ),
    );
    this.playerCollider = this.physics.createCollider(
      RAPIER.ColliderDesc.capsule(halfHeight, radius),
      this.player,
    );
    this.controller = this.physics.createCharacterController(0.025);
    this.controller.enableAutostep(0.45, 0.2, true);
    this.controller.enableSnapToGround(0.5);
    this.controller.setMaxSlopeClimbAngle(Math.PI / 3);
    this.controller.setMinSlopeSlideAngle(Math.PI / 4);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.controller.setCharacterMass(65);
    this.traffic.sync(
      this.chunks.active,
      this.config,
      this.clock.elapsedSeconds,
    );
    this.physics.propagateModifiedBodyPositionsToColliders();
    this.state = new WorldState(
      this.physics,
      this.origin,
      saved?.simulation?.entities.filter(
        (e) => !this.content.state.deletedIds.includes(e.id),
      ),
      this.content,
    );
    this.state.sync(
      this.chunks.active,
      this.chunks.assets,
      this.config,
      this.clock.tick,
    );
    this.syncSimulationResidency();
    if (saved?.execution) this.restoreCheckpoint(saved.execution);
    this.recordTrail(true);
  }

  subscribe(listener: WorldListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Observer movement never owns or advances the world clock. */
  updateObserver(realDelta: number, input: MovementInput): void {
    if (this.disposed || !Number.isFinite(realDelta) || realDelta < 0) return;
    this.observerTime += realDelta;
    // Bound each collision query, without discarding observer time.
    let remaining = realDelta;
    while (remaining > 1e-8) {
      const dt = Math.min(remaining, 1 / this.config.physics.frequency);
      remaining -= dt;
      const speed =
        this.config.physics.walkSpeed *
        (input.sprint ? this.config.physics.sprintMultiplier : 1);
      const magnitude = Math.max(1, Math.hypot(input.forward, input.right));
      const forward = input.forward / magnitude,
        right = input.right / magnitude;
      const dx =
        (-Math.sin(this.camera.yaw) * forward +
          Math.cos(this.camera.yaw) * right) *
        speed *
        dt;
      const dz =
        (-Math.cos(this.camera.yaw) * forward -
          Math.sin(this.camera.yaw) * right) *
        speed *
        dt;
      if (input.jump && !this.jumpHeld && this.grounded)
        this.verticalVelocity = this.config.physics.jumpSpeed;
      this.jumpHeld = input.jump;
      if (this.clock.paused || this.config.clock.timeScale === 0)
        this.verticalVelocity = 0;
      else this.verticalVelocity -= this.config.physics.gravity * dt;
      this.physics.propagateModifiedBodyPositionsToColliders();
      this.controller.computeColliderMovement(this.playerCollider, {
        x: dx,
        y: this.verticalVelocity * dt,
        z: dz,
      });
      const movement = this.controller.computedMovement(),
        p = this.player.translation();
      const next = {
        x: p.x + movement.x,
        y: p.y + movement.y,
        z: p.z + movement.z,
      };
      this.player.setTranslation(next, false);
      this.player.setNextKinematicTranslation(next);
      this.grounded = this.controller.computedGrounded();
      if (this.grounded && this.verticalVelocity < 0) this.verticalVelocity = 0;
      this.camera.x = next.x + this.origin.x;
      this.camera.z = next.z + this.origin.z;
      this.camera.y =
        next.y +
        this.config.physics.eyeHeight -
        this.config.physics.characterHalfHeight -
        this.config.physics.characterRadius;
      this.shiftOriginIfNeeded();
      this.syncChunks();
    }
    this.recordTrail();
  }

  advanceWorld(realDelta: number): void {
    if (
      this.disposed ||
      this.clock.paused ||
      this.config.clock.timeScale === 0 ||
      !Number.isFinite(realDelta) ||
      realDelta < 0
    )
      return;
    const dt = 1 / this.config.physics.frequency;
    this.accumulator += realDelta * this.config.clock.timeScale;
    const started = performance.now();
    let steps = 0;
    while (
      this.accumulator + 1e-12 >= dt &&
      steps++ < this.config.execution.maxStepsPerTurn
    ) {
      for (const id of this.pendingDrops.splice(0)) this.spawnDrop(id);
      this.syncSimulationResidency();
      this.traffic.sync(
        this.simulationChunks,
        this.config,
        this.clock.elapsedSeconds + dt,
      );
      this.physics.step();
      this.clock.advanceFixed(dt);
      this.state.capture(this.clock.tick);
      this.accumulator = Math.max(0, this.accumulator - dt);
    }
    this.stepMilliseconds = performance.now() - started;
  }

  /** Synchronous adapter retained for headless callers and deterministic tests. */
  update(realDelta: number, input: MovementInput): void {
    this.updateObserver(realDelta, input);
    this.advanceWorld(realDelta);
  }

  private syncSimulationResidency(): void {
    if (!this.state) return;
    this.state.sync(
      this.simulationChunks,
      this.chunks.assets,
      this.config,
      this.clock.tick,
    );
    const wanted = new Map<string, { q: number; r: number }>();
    this.residencyReasons.clear();
    const retain = (x: number, z: number, owner: string) => {
      for (const cell of hexDisk(
        worldToHex(x, z, this.config.chunkRadius),
        this.config.execution.supportLayers,
      )) {
        const key = hexKey(cell);
        wanted.set(key, cell);
        const owners = this.residencyReasons.get(key) ?? new Set<string>();
        owners.add(owner);
        this.residencyReasons.set(key, owners);
      }
    };
    for (const chunk of this.chunks.active.values()) {
      wanted.set(chunk.key, chunk.cell);
      this.residencyReasons.set(chunk.key, new Set(["observer"]));
    }
    for (const entity of this.state.entities.values()) {
      retain(entity.position.x, entity.position.z, `entity:${entity.id}`);
      const v = entity.linearVelocity,
        dt = 1 / this.config.physics.frequency;
      // CCD requires support along the reachable segment, before stepping.
      const segments = Math.max(
        1,
        Math.ceil(
          (Math.hypot(v.x, v.z) * dt) /
            (this.config.chunkRadius * this.config.execution.sweepStrideRadius),
        ),
      );
      for (let i = 1; i <= segments; i++)
        retain(
          entity.position.x + (v.x * dt * i) / segments,
          entity.position.z + (v.z * dt * i) / segments,
          `sweep:${entity.id}`,
        );
    }
    // A collider may extend far beyond its owner cell. Retain existing support
    // from its actual envelope, including sleeping contacts and next-step motion.
    for (const [key, chunk] of this.simulationChunks)
      if (!wanted.has(key)) {
        for (const asset of chunk.assets) {
          const reach = assetHorizontalReach(asset, this.config);
          if (!reach) continue;
          for (const entity of this.state.entities.values()) {
            const p = entity.position,
              v = entity.linearVelocity,
              dt = 1 / this.config.physics.frequency;
            const dx = v.x * dt,
              dz = v.z * dt,
              length2 = dx * dx + dz * dz;
            const t = length2
              ? Math.max(
                  0,
                  Math.min(
                    1,
                    ((asset.x - p.x) * dx + (asset.z - p.z) * dz) / length2,
                  ),
                )
              : 0;
            if (
              Math.hypot(asset.x - p.x - t * dx, asset.z - p.z - t * dz) >
              reach + Math.SQRT2 * entity.halfExtent
            )
              continue;
            wanted.set(key, chunk.cell);
            const owners = this.residencyReasons.get(key) ?? new Set<string>();
            owners.add(`collider:${asset.id}:entity:${entity.id}`);
            this.residencyReasons.set(key, owners);
          }
        }
      }
    for (const key of [...this.simulationChunks.keys()])
      if (!wanted.has(key)) this.simulationChunks.delete(key);
    for (const [key, cell] of wanted) {
      if (this.chunks.active.has(key))
        this.simulationChunks.set(key, this.chunks.active.get(key)!);
      if (!this.simulationChunks.has(key)) {
        const record = this.chunks.records.get(key),
          chunk = this.chunks.preparedChunk(cell);
        if (record && record.fingerprint !== chunk.fingerprint)
          throw new LocalizedError(
            "adapters.runtime.chunk-has-a-generation-fingerprint-that-differs-from-the",
            { p0: key },
          );
        this.chunks.records.set(key, {
          ...cell,
          fingerprint: chunk.fingerprint,
          firstTick: record?.firstTick ?? this.clock.tick,
          visits: record?.visits ?? 0,
          contentPackages: chunk.contentPackages,
        });
        this.simulationChunks.set(key, chunk);
      }
    }
    for (const [key, body] of this.chunkBodies)
      if (!wanted.has(key)) {
        this.physics.removeRigidBody(body);
        this.chunkBodies.delete(key);
      }
    for (const chunk of this.simulationChunks.values())
      if (!this.chunkBodies.has(chunk.key)) this.addTerrainBody(chunk);
    const assets = new Map<string, Asset>();
    for (const chunk of this.simulationChunks.values())
      for (const asset of chunk.assets) assets.set(asset.id, asset);
    for (const [id, body] of this.assetBodies)
      if (!assets.has(id)) {
        this.physics.removeRigidBody(body);
        this.assetBodies.delete(id);
      }
    for (const [id, asset] of assets)
      if (!this.assetBodies.has(id)) this.addAssetBody(asset);
    this.physics.propagateModifiedBodyPositionsToColliders();
  }

  look(dx: number, dy: number): void {
    this.camera.yaw -= dx * this.config.presentation.mouseSensitivity;
    this.camera.pitch = Math.max(
      -Math.PI * 0.47,
      Math.min(
        Math.PI * 0.47,
        this.camera.pitch - dy * this.config.presentation.mouseSensitivity,
      ),
    );
  }

  /** Useful for camera-path playback and future external controllers. */
  teleport(x: number, z: number, y?: number): void {
    this.camera.x = x;
    this.camera.z = z;
    this.shiftOriginIfNeeded();
    this.syncChunks();
    this.camera.y =
      y ?? this.groundHeight(x, z) + this.config.physics.eyeHeight + 0.1;
    const position = {
      x: x - this.origin.x,
      z: z - this.origin.z,
      y:
        this.camera.y -
        this.config.physics.eyeHeight +
        this.config.physics.characterHalfHeight +
        this.config.physics.characterRadius,
    };
    this.player.setTranslation(position, true);
    this.player.setNextKinematicTranslation(position);
    this.verticalVelocity = 0;
    this.physics.propagateModifiedBodyPositionsToColliders();
    this.recordTrail(true);
  }

  private syncChunks(force = false): void {
    const change = this.chunks.update(
      this.camera.x,
      this.camera.z,
      this.clock.tick,
      force,
    );
    if (!change.added.length && !change.removed.length) return;
    if (this.state) {
      this.syncSimulationResidency();
      this.traffic.sync(
        this.simulationChunks,
        this.config,
        this.clock.elapsedSeconds,
      );
    } else
      for (const chunk of change.added)
        if (!this.chunkBodies.has(chunk.key)) this.addTerrainBody(chunk);
    for (const listener of this.listeners) listener(change);
  }

  private addTerrainBody(chunk: ChunkData): void {
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(
        chunk.center.x - this.origin.x,
        0,
        chunk.center.z - this.origin.z,
      ),
    );
    this.physics.createCollider(
      RAPIER.ColliderDesc.trimesh(chunk.positions, chunk.indices).setFriction(
        0.85,
      ),
      body,
    );
    this.chunkBodies.set(chunk.key, body);
  }

  private addAssetBody(asset: Asset): void {
    const descriptors = assetColliders(asset, this.config);
    if (!descriptors.length) return;
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(
          asset.x - this.origin.x,
          asset.y,
          asset.z - this.origin.z,
        )
        .setRotation({
          x: 0,
          y: Math.sin(asset.rotation / 2),
          z: 0,
          w: Math.cos(asset.rotation / 2),
        }),
    );
    for (const descriptor of descriptors)
      this.physics.createCollider(descriptor, body);
    this.assetBodies.set(asset.id, body);
  }

  private shiftOriginIfNeeded(): void {
    const threshold =
      this.config.chunkRadius * this.config.physics.originShiftChunks;
    if (
      Math.abs(this.camera.x - this.origin.x) < threshold &&
      Math.abs(this.camera.z - this.origin.z) < threshold
    )
      return;
    const x = Math.round(this.camera.x / threshold) * threshold - this.origin.x;
    const z = Math.round(this.camera.z / threshold) * threshold - this.origin.z;
    this.origin.x += x;
    this.origin.z += z;
    this.physics.bodies.forEach((body) => {
      const p = body.translation(),
        next = { x: p.x - x, y: p.y, z: p.z - z };
      body.setTranslation(next, false);
      if (body.isKinematic()) body.setNextKinematicTranslation(next);
    });
  }

  private recordTrail(force = false): void {
    const previous = this.trail.at(-1);
    if (
      !force &&
      previous &&
      Math.hypot(previous.x - this.camera.x, previous.z - this.camera.z) <
        this.config.recording.trailSpacing
    )
      return;
    this.trail.push({
      x: this.camera.x,
      y: this.camera.y,
      z: this.camera.z,
      tick: this.clock.tick,
    });
    if (this.trail.length > this.config.recording.maxTrailPoints) {
      const recentStart = Math.floor(this.trail.length / 2);
      this.trail.splice(
        0,
        recentStart,
        ...this.trail.slice(0, recentStart).filter((_, i) => i % 2 === 0),
      );
    }
  }

  observation(): Observation {
    return {
      worldId: this.id,
      generatorVersion: GENERATOR_VERSION,
      tick: this.clock.tick,
      worldSeconds: this.clock.elapsedSeconds,
      revision: this.content.state.revision,
      observerTime: this.observerTime,
      camera: { ...this.camera },
      origin: { ...this.origin },
      activeChunks: [...this.chunks.active.values()].map((chunk) => ({
        key: chunk.key,
        fingerprint: chunk.fingerprint,
      })),
      simulation: {
        paused: this.clock.paused,
        gravity: this.config.physics.gravity,
        activeBodies: this.state.bodies.size,
        dormantBodies: this.state.entities.size - this.state.bodies.size,
        entities: [...this.state.bodies.keys()].map((id) =>
          structuredClone(this.state.entities.get(id)!),
        ),
      },
    };
  }

  snapshot(includePhysics = false): WorldSnapshot {
    return {
      formatVersion: SAVE_VERSION,
      generatorVersion: GENERATOR_VERSION,
      id: this.id,
      name: this.name,
      config: structuredClone(this.config),
      tick: this.clock.tick,
      elapsedSeconds: this.clock.elapsedSeconds,
      camera: { ...this.camera },
      chunks: [...this.chunks.records.values()].map((record) => ({
        ...record,
      })),
      trail: this.trail.map((point) => ({ ...point })),
      savedAt: new Date().toISOString(),
      simulation: {
        paused: this.clock.paused,
        verticalVelocity: this.verticalVelocity,
        grounded: this.grounded,
        entities: this.state.snapshot(),
      },
      content: structuredClone(this.content.state),
      events: structuredClone(this.events),
      ...(includePhysics ? { execution: this.physicsCheckpoint() } : {}),
    };
  }

  applyRuntimeConfig(config: WorldConfig): void {
    this.config = config;
    this.chunks.config = config;
    this.chunks.invalidatePrepared();
    this.clock.config = config.clock;
    this.physics.gravity = { x: 0, y: -config.physics.gravity, z: 0 };
    this.physics.timestep = 1 / config.physics.frequency;
    this.syncChunks(true);
  }

  /** An explicit object edit, separate from the immutable chunk recipe. */
  installContent(
    pack: ContentPackage,
    options: {
      futureChunks?: boolean;
      targetId?: string;
      asset?: string;
      constraint?: ObjectConstraint;
    } = {},
  ): void {
    const target = options.targetId
      ? this.chunks.assets.get(options.targetId)
      : undefined;
    if (
      options.targetId &&
      (!target || !options.asset || !pack.assets[options.asset])
    )
      throw new LocalizedError(
        "adapters.runtime.select-a-loaded-object-and-a-valid-asset",
      );
    const collider = options.asset
      ? pack.assets[options.asset]?.collider
      : undefined;
    if (target && collider) {
      const [cx, cy, cz] = collider.center.map((v) => v * target.scale),
        [hx, hy, hz] = collider.halfExtents.map((v) => v * target.scale);
      let blocked = false;
      const terrainHandles = new Set(
        [...this.chunkBodies.values()].map((body) => body.handle),
      );
      const position = {
        x:
          target.x -
          this.origin.x +
          Math.cos(target.rotation) * cx +
          Math.sin(target.rotation) * cz,
        y: target.y + cy,
        z:
          target.z -
          this.origin.z -
          Math.sin(target.rotation) * cx +
          Math.cos(target.rotation) * cz,
      };
      const rotation = {
          x: 0,
          y: Math.sin(target.rotation / 2),
          z: 0,
          w: Math.cos(target.rotation / 2),
        },
        shape = new RAPIER.Cuboid(hx, hy, hz);
      this.physics.propagateModifiedBodyPositionsToColliders();
      // Direct narrow-phase checks work immediately after streaming, even while the clock is paused.
      this.physics.colliders.forEach((c) => {
        const body = c.parent();
        if (
          terrainHandles.has(body?.handle ?? -1) ||
          body?.handle === this.assetBodies.get(target.id)?.handle
        )
          return;
        if (c.intersectsShape(shape, position, rotation)) blocked = true;
      });
      if (blocked)
        throw new LocalizedError(
          "adapters.runtime.the-new-collider-overlaps-a-nearby-object-or-the",
        );
    }
    this.content.install(pack, options.futureChunks ?? false);
    this.chunks.invalidatePrepared();
    if (target) {
      this.content.state.overrides[target.id] = {
        package: `${pack.id}@${pack.version}`,
        asset: options.asset!,
      };
      for (const chunk of this.chunks.active.values())
        for (const a of chunk.assets)
          if (a.id === target.id) this.content.applyOverride(a);
      const body = this.assetBodies.get(target.id);
      if (body) this.physics.removeRigidBody(body);
      this.assetBodies.delete(target.id);
      this.addAssetBody(target);
      this.physics.propagateModifiedBodyPositionsToColliders();
    }
    if (options.constraint) this.setObjectConstraint(options.constraint);
    for (const listener of this.listeners)
      listener({ added: [], removed: [], center: this.chunks.center });
  }

  setObjectConstraint(constraint: ObjectConstraint): void {
    constraint = objectConstraintSchema.parse(constraint);
    const all = this.content.state.constraints;
    const index = all.findIndex((c) => c.objectId === constraint.objectId);
    if (index >= 0) all[index] = structuredClone(constraint);
    else all.push(structuredClone(constraint));
    this.content.state.revision++;
  }

  groundHeight(x: number, z: number): number {
    const chunk = this.chunks.active.get(
      hexKey(worldToHex(x, z, this.config.chunkRadius)),
    );
    return chunk
      ? (surfaceHeight(chunk, x, z) ?? terrainHeight(x, z, this.config))
      : terrainHeight(x, z, this.config);
  }

  validatePlacement(asset: Asset, excludeId?: string): void {
    if (
      !this.chunks.active.has(
        hexKey(worldToHex(asset.x, asset.z, this.config.chunkRadius)),
      )
    )
      throw new LocalizedError(
        "adapters.runtime.this-position-is-outside-the-loaded-area-move-closer",
      );
    if (
      !Object.values(asset)
        .filter((v) => typeof v === "number")
        .every(Number.isFinite)
    )
      throw new LocalizedError("adapters.runtime.invalid-object-coordinates");
    if (asset.y < this.config.terrain.waterLevel - 0.05)
      throw new LocalizedError(
        "adapters.runtime.choose-a-ground-anchor-above-the-water",
      );
    const colliders = [
      ...(asset.design?.collider ? [asset.design.collider] : []),
      ...(asset.design?.colliders ?? []),
    ];
    for (const collider of colliders)
      for (const dx of [-1, 1])
        for (const dz of [-1, 1]) {
          const px =
              (collider.center[0] + dx * collider.halfExtents[0]) * asset.scale,
            pz =
              (collider.center[2] + dz * collider.halfExtents[2]) * asset.scale;
          const x =
            asset.x +
            Math.cos(asset.rotation) * px +
            Math.sin(asset.rotation) * pz;
          const z =
            asset.z -
            Math.sin(asset.rotation) * px +
            Math.cos(asset.rotation) * pz;
          if (
            !this.chunks.active.has(
              hexKey(worldToHex(x, z, this.config.chunkRadius)),
            )
          )
            throw new LocalizedError(
              "adapters.runtime.the-object-envelope-extends-outside-the-loaded-area-move",
            );
          if (
            this.groundHeight(x, z) -
              (asset.y +
                (collider.center[1] - collider.halfExtents[1]) * asset.scale) >
            0.7
          )
            throw new LocalizedError(
              "adapters.runtime.the-slope-would-bury-the-object-in-the-terrain",
            );
        }
    const temporary = new RAPIER.World({ x: 0, y: 0, z: 0 });
    try {
      const body = temporary.createRigidBody(
        RAPIER.RigidBodyDesc.fixed()
          .setTranslation(
            asset.x - this.origin.x,
            asset.y,
            asset.z - this.origin.z,
          )
          .setRotation({
            x: 0,
            y: Math.sin(asset.rotation / 2),
            z: 0,
            w: Math.cos(asset.rotation / 2),
          }),
      );
      for (const descriptor of assetColliders(asset, this.config))
        temporary.createCollider(descriptor, body);
      temporary.propagateModifiedBodyPositionsToColliders();
      this.physics.propagateModifiedBodyPositionsToColliders();
      const terrain = new Set(
        [...this.chunkBodies.values()].map((b) => b.handle),
      );
      const excluded =
        this.assetBodies.get(excludeId ?? "") ??
        this.state?.bodies.get(excludeId ?? "") ??
        this.traffic.bodies.get(excludeId ?? "");
      let blocked = false;
      temporary.colliders.forEach((query) =>
        this.physics.colliders.forEach((c) => {
          if (
            terrain.has(c.parent()?.handle ?? -1) ||
            c.parent()?.handle === excluded?.handle
          )
            return;
          if (
            c.intersectsShape(
              query.shape,
              query.translation(),
              query.rotation(),
            )
          )
            blocked = true;
        }),
      );
      if (blocked)
        throw new LocalizedError(
          "adapters.runtime.the-placement-collides-with-another-object-or-the-camera",
        );
    } finally {
      temporary.free();
    }
  }

  refreshEditedObjects(): void {
    this.chunks.invalidatePrepared();
    for (const chunk of new Map([
      ...this.simulationChunks,
      ...this.chunks.active,
    ]).values())
      chunk.assets = this.content.generate(
        chunk.cell,
        this.config,
        this.chunks.records.get(chunk.key),
      ).assets;
    for (const body of this.assetBodies.values())
      this.physics.removeRigidBody(body);
    this.assetBodies.clear();
    this.syncSimulationResidency();
    this.state.sync(
      this.chunks.active,
      this.chunks.assets,
      this.config,
      this.clock.tick,
    );
    this.traffic.sync(
      this.chunks.active,
      this.config,
      this.clock.elapsedSeconds,
    );
    this.physics.propagateModifiedBodyPositionsToColliders();
    for (const listener of this.listeners)
      listener({ added: [], removed: [], center: this.chunks.center });
  }

  recordEvent(
    id: string,
    operation: string,
    objectIds: string[] = [],
    regions: string[] = [],
  ): void {
    this.events.push({
      id,
      worldId: this.id,
      tick: this.clock.tick,
      worldSeconds: this.clock.elapsedSeconds,
      revision: this.content.state.revision,
      operation,
      objectIds,
      regions,
    });
    if (this.events.length > this.config.execution.eventHistoryLimit)
      this.events.splice(
        0,
        this.events.length - this.config.execution.eventHistoryLimit,
      );
  }

  dropPhysicsObject(): string {
    if (
      this.state.entities.size + this.pendingDrops.length >=
      this.config.physics.maxActiveBodies
    )
      throw new LocalizedError(
        "adapters.runtime.the-dynamic-body-limit-has-been-reached",
      );
    const x = this.camera.x - Math.sin(this.camera.yaw) * 3,
      z = this.camera.z - Math.cos(this.camera.yaw) * 3;
    const drop = {
      id: `crate:${crypto.randomUUID()}`,
      x,
      y: Math.max(this.camera.y + 3, terrainHeight(x, z, this.config) + 4),
      z,
    };
    if (this.clock.paused || this.config.clock.timeScale === 0)
      this.pendingDrops.push(drop);
    else this.spawnDrop(drop);
    if (this.clock.paused || this.config.clock.timeScale === 0)
      this.recordEvent(`${drop.id}:queued`, "physics.queued", [drop.id]);
    return drop.id;
  }
  private spawnDrop(drop: {
    id: string;
    x: number;
    y: number;
    z: number;
  }): void {
    this.state.create(drop.id, drop.x, drop.y, drop.z, this.clock.tick);
    this.recordEvent(`${drop.id}:applied`, "physics.create", [drop.id]);
    this.syncSimulationResidency();
  }

  private physicsCheckpoint(): NonNullable<WorldSnapshot["execution"]> {
    const bytes = this.physics.takeSnapshot();
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const handles = (
      bodies: Map<string, RAPIER.RigidBody>,
    ): [string, number][] => [...bodies].map(([id, body]) => [id, body.handle]);
    return {
      engine: "rapier3d-compat",
      engineVersion: RAPIER.version(),
      build: PHYSICS_BUILD,
      binary: btoa(binary),
      origin: { ...this.origin },
      player: this.player.handle,
      playerCollider: this.playerCollider.handle,
      chunkBodies: handles(this.chunkBodies),
      assetBodies: handles(this.assetBodies),
      entityBodies: handles(this.state.bodies),
      trafficBodies: handles(this.traffic.bodies),
      accumulator: this.accumulator,
      observerTime: this.observerTime,
      jumpHeld: this.jumpHeld,
      pendingDrops: structuredClone(this.pendingDrops),
    };
  }
  private restoreCheckpoint(
    checkpoint: NonNullable<WorldSnapshot["execution"]>,
  ): void {
    const restored = RAPIER.World.restoreSnapshot(
      Uint8Array.from(atob(checkpoint.binary), (c) => c.charCodeAt(0)),
    );
    const body = restored.getRigidBody(checkpoint.player),
      collider = restored.getCollider(checkpoint.playerCollider);
    if (!body || !collider) {
      restored.free();
      throw new LocalizedError(
        "adapters.runtime.the-physics-snapshot-is-missing-its-observer-mapping",
      );
    }
    this.physics.free();
    this.physics = restored;
    Object.assign(this.origin, checkpoint.origin);
    this.player = body;
    this.playerCollider = collider;
    this.controller = this.physics.createCharacterController(0.025);
    this.controller.enableAutostep(0.45, 0.2, true);
    this.controller.enableSnapToGround(0.5);
    this.controller.setMaxSlopeClimbAngle(Math.PI / 3);
    this.controller.setMinSlopeSlideAngle(Math.PI / 4);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.controller.setCharacterMass(65);
    this.chunkBodies.clear();
    this.assetBodies.clear();
    this.simulationChunks.clear();
    for (const [key, handle] of checkpoint.chunkBodies) {
      this.chunkBodies.set(key, restored.getRigidBody(handle));
      this.simulationChunks.set(
        key,
        this.content.generate(
          parseHexKey(key),
          this.config,
          this.chunks.records.get(key),
        ),
      );
    }
    for (const [key, handle] of checkpoint.assetBodies)
      this.assetBodies.set(key, restored.getRigidBody(handle));
    this.state.restorePhysics(restored, checkpoint.entityBodies);
    this.traffic.restorePhysics(restored, checkpoint.trafficBodies);
    this.accumulator = checkpoint.accumulator;
    this.observerTime = checkpoint.observerTime;
    this.jumpHeld = checkpoint.jumpHeld;
    this.pendingDrops = structuredClone(checkpoint.pendingDrops);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.physics.free();
  }
}

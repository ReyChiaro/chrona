import { LocalizedError } from "../../../i18n/src/index";
import { msg } from "../../../i18n/src/index";
import RAPIER from "@dimforge/rapier3d-compat";
import { EntityState } from "../../../world/src/state";
import type { DynamicEntityState } from "../../../protocol/src/contracts";
import type { WorldConfig } from "../../../protocol/src/config";
import type { Asset, ChunkData } from "../../../world/src/generator";
import { hexKey, worldToHex } from "../../../world/src/hex";
import { terrainHeight } from "../../../world/src/terrain";
import type { WorldContent } from "../../../world/src/content";

/** Authoritative object state is independent of meshes, cameras and chunk geometry. */
export class WorldState extends EntityState {
  readonly bodies = new Map<string, RAPIER.RigidBody>();
  readonly blockedSpawns = new Set<string>();
  restorePhysics(physics: RAPIER.World, handles: [string, number][]): void {
    this.physics = physics;
    this.bodies.clear();
    for (const [id, handle] of handles) {
      const body = physics.getRigidBody(handle);
      if (!body)
        throw new LocalizedError(
          "adapters.state.the-physics-snapshot-is-missing-object",
          { p0: id },
        );
      this.bodies.set(id, body);
    }
  }
  constructor(
    private physics: RAPIER.World,
    private origin: { x: number; z: number },
    saved: DynamicEntityState[] = [],
    private content?: WorldContent,
  ) {
    super(saved);
  }

  sync(
    chunks: Map<string, ChunkData>,
    assets: Map<string, Asset>,
    config: WorldConfig,
    tick: number,
  ): void {
    this.blockedSpawns.clear();
    for (const asset of assets.values()) {
      if (asset.kind !== "bridge") continue;
      const id = `crate:${asset.id}`;
      if (
        this.content?.state.deletedIds.includes(id) ||
        this.content?.state.additions[id]
      )
        continue;
      if (!this.entities.has(id)) {
        if (this.entities.size >= config.physics.maxActiveBodies) {
          this.blockedSpawns.add(id);
          continue;
        }
        const x = asset.x + config.population.bridgeWidth * 1.4,
          z = asset.z - config.terrain.riverWidth * 1.5;
        this.create(id, x, terrainHeight(x, z, config) + 4, z, tick);
      }
    }
    for (const [id, entity] of this.entities) {
      const loaded = chunks.has(
        hexKey(
          worldToHex(entity.position.x, entity.position.z, config.chunkRadius),
        ),
      );
      const body = this.bodies.get(id);
      // Bodies remain in the same Rapier world, including sleeping islands.
      // Residency retains their support and wake-up paths independently of the viewer.
      if (!body) this.activate(entity);
    }
  }

  replace(id: string, entity?: DynamicEntityState): void {
    const body = this.bodies.get(id);
    if (body) this.physics.removeRigidBody(body);
    this.bodies.delete(id);
    super.replace(id, entity);
  }

  private activate(entity: DynamicEntityState): void {
    const p = entity.position;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.x - this.origin.x, p.y, p.z - this.origin.z)
      .setRotation(entity.rotation)
      .setLinvel(
        entity.linearVelocity.x,
        entity.linearVelocity.y,
        entity.linearVelocity.z,
      )
      .setAngvel(entity.angularVelocity)
      .setLinearDamping(0.15)
      .setAngularDamping(0.25)
      .setCcdEnabled(true);
    const body = this.physics.createRigidBody(desc);
    const size = entity.halfExtent;
    this.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(size, size, size)
        .setDensity(0.5)
        .setFriction(0.85)
        .setRestitution(0.12),
      body,
    );
    if (entity.sleeping) body.sleep();
    this.bodies.set(entity.id, body);
  }

  capture(tick: number): void {
    for (const [id, body] of this.bodies) {
      const entity = this.entities.get(id)!;
      const p = body.translation();
      entity.position = {
        x: p.x + this.origin.x,
        y: p.y,
        z: p.z + this.origin.z,
      };
      entity.rotation = { ...body.rotation() };
      entity.linearVelocity = { ...body.linvel() };
      entity.angularVelocity = { ...body.angvel() };
      entity.updatedTick = tick;
      entity.sleeping = body.isSleeping();
    }
  }

  suspendAll(tick: number): void {
    this.capture(tick);
    for (const body of this.bodies.values()) this.physics.removeRigidBody(body);
    this.bodies.clear();
  }
}

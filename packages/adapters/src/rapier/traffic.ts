import { LocalizedError } from "../../../i18n/src/index";
import { msg } from "../../../i18n/src/index";
import RAPIER from "@dimforge/rapier3d-compat";
import type { ContentPackage } from "../../../protocol/src/content";
import type { WorldConfig } from "../../../protocol/src/config";
import type { RegionRecipe } from "../../../protocol/src/regions";
import { hexKey, worldToHex } from "../../../world/src/hex";
import type { Asset, ChunkData } from "../../../world/src/generator";
import { regionKey, regionRoads } from "../../../world/src/regions";
import { assetColliders } from "./asset-colliders";
import type { WorldContent } from "../../../world/src/content";

import { vehiclePose } from "../../../world/src/traffic";
export { vehiclePose } from "../../../world/src/traffic";

export class RegionalTraffic {
  readonly assets = new Map<string, Asset>();
  readonly bodies = new Map<string, RAPIER.RigidBody>();
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
    private content: WorldContent,
  ) {}
  resolve(id: string, seconds: number): Asset | undefined {
    for (const pack of this.content.state.packages)
      if (pack.region)
        for (const vehicle of pack.region.vehicles)
          if (`${regionKey(pack)}:vehicle:${vehicle.id}` === id)
            return vehiclePose(pack, vehicle, seconds);
    return undefined;
  }
  sync(
    active: Map<string, ChunkData>,
    config: WorldConfig,
    seconds: number,
  ): void {
    const pins = new Set(
        [...active.values()].flatMap((c) => c.contentPackages ?? []),
      ),
      next = new Map<string, Asset>();
    for (const pack of this.content.state.packages)
      if (pack.region && pins.has(regionKey(pack)))
        for (const vehicle of pack.region.vehicles) {
          const a = vehiclePose(pack, vehicle, seconds);
          if (
            !active
              .get(hexKey(worldToHex(a.x, a.z, config.chunkRadius)))
              ?.contentPackages?.includes(regionKey(pack)) ||
            this.content.state.deletedIds.includes(a.id)
          )
            continue;
          next.set(a.id, a);
          let body = this.bodies.get(a.id);
          if (!body) {
            body = this.physics.createRigidBody(
              RAPIER.RigidBodyDesc.kinematicPositionBased()
                .setTranslation(a.x - this.origin.x, a.y, a.z - this.origin.z)
                .setRotation({
                  x: 0,
                  y: Math.sin(a.rotation / 2),
                  z: 0,
                  w: Math.cos(a.rotation / 2),
                }),
            );
            for (const desc of assetColliders(a, config))
              this.physics.createCollider(desc, body);
            this.bodies.set(a.id, body);
          }
          body.setNextKinematicTranslation({
            x: a.x - this.origin.x,
            y: a.y,
            z: a.z - this.origin.z,
          });
          body.setNextKinematicRotation({
            x: 0,
            y: Math.sin(a.rotation / 2),
            z: 0,
            w: Math.cos(a.rotation / 2),
          });
        }
    for (const [id, body] of this.bodies)
      if (!next.has(id)) {
        this.physics.removeRigidBody(body);
        this.bodies.delete(id);
      }
    this.assets.clear();
    for (const [id, a] of next) this.assets.set(id, a);
  }
}

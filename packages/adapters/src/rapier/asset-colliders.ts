import RAPIER from "@dimforge/rapier3d-compat";
import type { Asset } from "../../../world/src/generator";
import type { WorldConfig } from "../../../protocol/src/config";

/** The same descriptors drive placement validation and authoritative physics. */
export function assetColliders(
  asset: Asset,
  config: WorldConfig,
): RAPIER.ColliderDesc[] {
  const boxes: RAPIER.ColliderDesc[] = [];
  const box = (
    x: number,
    y: number,
    z: number,
    px: number,
    py: number,
    pz: number,
  ) =>
    boxes.push(RAPIER.ColliderDesc.cuboid(x, y, z).setTranslation(px, py, pz));
  if (asset.design) {
    for (const { halfExtents: h, center: p } of asset.design.colliders ?? [])
      box(
        ...(h.map((v) => v * asset.scale) as [number, number, number]),
        ...(p.map((v) => v * asset.scale) as [number, number, number]),
      );
    if (asset.design.collider) {
      const { halfExtents: h, center: p } = asset.design.collider;
      box(
        ...(h.map((v) => v * asset.scale) as [number, number, number]),
        ...(p.map((v) => v * asset.scale) as [number, number, number]),
      );
    }
  } else if (asset.kind === "pine" || asset.kind === "birch") {
    const height = config.population.treeHeight * asset.scale;
    boxes.push(
      RAPIER.ColliderDesc.cylinder(
        height * 0.22,
        height * 0.045,
      ).setTranslation(0, height * 0.22, 0),
    );
  } else if (asset.kind === "house") {
    const width = config.population.houseWidth * asset.scale,
      height = config.population.houseHeight * asset.scale;
    box(width / 2, height * 0.32, width * 0.42, 0, height * 0.32, 0);
  } else if (asset.kind === "bridge") {
    const width = config.population.bridgeWidth,
      length = config.terrain.riverWidth * 2.3;
    box(width / 2, 0.18, length / 2, 0, -0.18, 0);
    for (const side of [-1, 1])
      box(0.1, 0.45, length / 2, (side * width) / 2, 0.6, 0);
  }
  return boxes;
}

/** Conservative horizontal reach, derived from the descriptors used by physics. */
export function assetHorizontalReach(
  asset: Asset,
  config: WorldConfig,
): number {
  return Math.max(
    0,
    ...assetColliders(asset, config).map(({ shape, translation }) => {
      const radius =
        shape instanceof RAPIER.Cuboid
          ? Math.hypot(shape.halfExtents.x, shape.halfExtents.z)
          : (shape as RAPIER.Cylinder).radius;
      return Math.hypot(translation.x, translation.z) + radius;
    }),
  );
}

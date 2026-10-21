import * as THREE from "three";
import type { Asset } from "../../world/src/generator";
import type { WorldConfig } from "../../protocol/src/config";
import { createAssetVisual } from "./assets";
import { disposeGroup } from "./chunk-visual";

export const isVegetation = (asset: Asset): boolean =>
  !asset.design && ["pine", "birch", "shrub", "rock"].includes(asset.kind);

/** Shared geometry keeps dense vegetation inexpensive across all camera renderers. */
export class VegetationView {
  readonly group = new THREE.Group();
  private batches: {
    mesh: THREE.InstancedMesh;
    local: THREE.Matrix4;
    assets: Asset[];
  }[] = [];
  private born = new Map<string, number>();
  private matrix = new THREE.Matrix4();
  private transform = new THREE.Object3D();

  sync(assets: Asset[], config: WorldConfig, now: number): void {
    for (const batch of this.batches) batch.mesh.dispose();
    disposeGroup(this.group);
    this.group.clear();
    this.batches = [];
    const ids = new Set(assets.map((asset) => asset.id));
    for (const id of this.born.keys()) if (!ids.has(id)) this.born.delete(id);
    for (const asset of assets)
      if (!this.born.has(asset.id)) this.born.set(asset.id, now);
    for (const kind of ["pine", "birch", "shrub", "rock"] as const) {
      const entries = assets.filter((asset) => asset.kind === kind);
      if (!entries.length) continue;
      const prototype = createAssetVisual(
        { ...entries[0], scale: 1, rotation: 0, variant: 0.5 },
        config,
      );
      prototype.updateMatrixWorld(true);
      prototype.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const mesh = new THREE.InstancedMesh(
          object.geometry.clone(),
          (object.material as THREE.Material).clone(),
          entries.length,
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.userData.objectIds = entries.map((a) => a.id);
        this.group.add(mesh);
        this.batches.push({
          mesh,
          local: object.matrixWorld.clone(),
          assets: entries,
        });
      });
      disposeGroup(prototype);
    }
  }

  update(
    origin: { x: number; z: number },
    config: WorldConfig,
    now: number,
    animated: boolean,
  ): void {
    for (const batch of this.batches) {
      batch.assets.forEach((asset, i) => {
        const t =
          animated && config.presentation.animationDuration > 0
            ? Math.min(
                1,
                (now - this.born.get(asset.id)!) /
                  config.presentation.animationDuration,
              )
            : 1;
        this.transform.position.set(
          asset.x - origin.x,
          asset.y - Math.pow(1 - t, 3) * config.presentation.riseDistance,
          asset.z - origin.z,
        );
        this.transform.rotation.set(0, asset.rotation, 0);
        this.transform.scale.setScalar(asset.scale);
        this.transform.updateMatrix();
        this.matrix.multiplyMatrices(this.transform.matrix, batch.local);
        batch.mesh.setMatrixAt(i, this.matrix);
      });
      batch.mesh.instanceMatrix.needsUpdate = true;
      // Recomputed on demand by raycast after floating-origin shifts or streamed transforms.
      batch.mesh.boundingSphere = null;
    }
  }

  dispose(): void {
    for (const batch of this.batches) batch.mesh.dispose();
    disposeGroup(this.group);
  }
}

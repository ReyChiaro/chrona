import { msg } from '../../i18n/src/index';
import * as THREE from 'three';
import type { SceneSelection } from '../../protocol/src/content';
import type { WorldReadModel as WorldRuntime } from '../../world/src/ports/read-model';

/** IDs come from real rendered geometry, including instanced trees and non-solid decoration. */
export function pickScene(runtime: WorldRuntime, camera: THREE.PerspectiveCamera, roots: THREE.Object3D[], ndc = new THREE.Vector2()): SceneSelection | null {
  camera.updateMatrixWorld(); const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera); ray.far = Math.min(camera.far, 250);
  for (const hit of ray.intersectObjects(roots, true)) {
    if (!(hit.object instanceof THREE.Mesh)) continue;
    let node: THREE.Object3D | null = hit.object, id: string | undefined;
    if (hit.instanceId !== undefined) id = hit.object.userData.objectIds?.[hit.instanceId];
    while (node && !id) { id = node.userData.objectId; node = node.parent; }
    const point = { x: hit.point.x + runtime.origin.x, y: hit.point.y, z: hit.point.z + runtime.origin.z };
    if (id) {
      const asset = runtime.sceneAssets.get(id);
      return { kind: 'object', objectId: id, version: runtime.editor.version(id), point, label: asset?.design?.label ?? asset?.kind ?? msg('viewer.selection.physics-cube') };
    }
    if (hit.object.userData.pickRole === 'wall' || hit.object.userData.pickRole === 'water') return null;
    if (hit.object.userData.pickRole === 'ground') {
      const normal = hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? new THREE.Vector3(0, 1, 0);
      if (normal.y < 0.45) return null;
      return { kind: 'ground', label: msg('viewer.selection.ground-anchor'), point, normal: { x: normal.x, y: normal.y, z: normal.z } };
    }
  }
  return null;
}

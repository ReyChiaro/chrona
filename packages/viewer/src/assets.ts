import * as THREE from 'three';
import { PALETTE, type WorldConfig } from '../../protocol/src/config';
import type { Asset } from '../../world/src/generator';
import { resolvePartMaterial } from '../../protocol/src/materials';
import { createSurfaceMaterial } from './materials';

const material = (color: string, extras: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true, ...extras });
function mesh(geometry: THREE.BufferGeometry, color: string, group: THREE.Group, position: number[]): THREE.Mesh {
  const object = new THREE.Mesh(geometry, material(color));
  object.position.set(position[0], position[1], position[2]);
  object.castShadow = true; object.receiveShadow = true; group.add(object);
  return object;
}
function box(group: THREE.Group, size: number[], position: number[], color: string): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), color, group, position);
}

export function createAssetVisual(asset: Asset, config: WorldConfig): THREE.Group {
  const group = new THREE.Group();
  group.name = asset.id;
  group.rotation.y = asset.rotation;
  if (asset.design) {
    group.scale.setScalar(asset.scale);
    const materials = new Map<string, THREE.MeshStandardMaterial>();
    for (const part of asset.design.parts) {
      const [x, y, z] = part.size;
      const geometry = part.shape === 'box' ? new THREE.BoxGeometry(x, y, z)
        : part.shape === 'sphere' ? new THREE.IcosahedronGeometry(1, 1)
        : part.shape === 'cone' ? new THREE.ConeGeometry(x / 2, y, 8)
        : new THREE.CylinderGeometry(x / 2, z / 2, y, 8);
      const spec = resolvePartMaterial(asset.design, part);
      const key = JSON.stringify(spec);
      if (!materials.has(key)) materials.set(key, createSurfaceMaterial(spec));
      const object = new THREE.Mesh(geometry, materials.get(key));
      object.position.set(...part.position); object.castShadow = (spec.opacity ?? 1) >= 1; object.receiveShadow = true;
      object.userData.materialId = 'material' in part ? part.material : undefined; group.add(object);
      if (part.shape === 'sphere') object.scale.set(x / 2, y / 2, z / 2);
    }
    return group;
  }
  if (asset.kind === 'pine') {
    const height = config.population.treeHeight * asset.scale;
    mesh(new THREE.CylinderGeometry(height * 0.035, height * 0.055, height * 0.5, 5), PALETTE.trunk, group, [0, height * 0.25, 0]);
    for (let layer = 0; layer < 3; layer++) {
      const radius = height * (0.29 - layer * 0.065);
      mesh(new THREE.ConeGeometry(radius, height * 0.5, 6), layer % 2 ? PALETTE.pineLight : PALETTE.pine,
        group, [0, height * (0.48 + layer * 0.18), 0]);
    }
  } else if (asset.kind === 'birch') {
    const height = config.population.treeHeight * asset.scale;
    mesh(new THREE.CylinderGeometry(height * 0.035, height * 0.06, height * 0.8, 5), '#d6d4bb', group, [0, height * 0.4, 0]);
    const crown = mesh(new THREE.IcosahedronGeometry(height * 0.32, 0), '#88a965', group, [0, height * 0.84, 0]);
    crown.scale.y = 1.3;
  } else if (asset.kind === 'shrub') {
    const shrub = mesh(new THREE.IcosahedronGeometry(asset.scale * 0.9, 0), '#6e934e', group, [0, asset.scale * 0.55, 0]);
    shrub.scale.y = 0.75;
  } else if (asset.kind === 'rock') {
    const rock = mesh(new THREE.IcosahedronGeometry(asset.scale * 0.9, 0), PALETTE.rock, group, [0, asset.scale * 0.4, 0]);
    rock.scale.set(1.3, 0.8, 1);
  } else if (asset.kind === 'house') {
    const width = config.population.houseWidth * asset.scale;
    const height = config.population.houseHeight * asset.scale;
    const depth = width * 0.84, wallHeight = height * 0.64, roofHeight = height * 0.36;
    box(group, [width + 0.3, 0.35, depth + 0.3], [0, 0.1, 0], PALETTE.rock);
    box(group, [width, wallHeight, depth], [0, wallHeight / 2 + 0.15, 0], PALETTE.wall);
    const roof = new THREE.BufferGeometry();
    const w = width * 0.58, d = depth * 0.62, base = wallHeight + 0.1;
    roof.setAttribute('position', new THREE.Float32BufferAttribute([
      -w, base, -d, w, base, -d, 0, base + roofHeight, -d,
      -w, base, d, 0, base + roofHeight, d, w, base, d,
      -w, base, -d, 0, base + roofHeight, -d, -w, base, d,
      -w, base, d, 0, base + roofHeight, -d, 0, base + roofHeight, d,
      0, base + roofHeight, -d, w, base, -d, w, base, d,
      0, base + roofHeight, -d, w, base, d, 0, base + roofHeight, d,
    ], 3));
    roof.setIndex(Array.from({ length: 6 }, (_, triangle) => [triangle * 3, triangle * 3 + 2, triangle * 3 + 1]).flat());
    roof.computeVertexNormals();
    mesh(roof, asset.variant > 0.5 ? PALETTE.roof : PALETTE.roofDark, group, [0, 0, 0]);
    box(group, [width * 0.18, wallHeight * 0.65, 0.06], [0, wallHeight * 0.325 + 0.15, depth / 2 + 0.035], PALETTE.timber);
    for (const side of [-1, 1]) {
      box(group, [width * 0.18, wallHeight * 0.23, 0.07], [side * width * 0.29, wallHeight * 0.6, depth / 2 + 0.045], '#708d8a');
      box(group, [0.07, wallHeight * 0.27, width * 0.19], [side * (width / 2 + 0.035), wallHeight * 0.58, 0], '#708d8a');
    }
    box(group, [width * 0.12, height * 0.25, width * 0.12], [width * 0.27, height * 0.86, -depth * 0.18], PALETTE.rock);
  } else if (asset.kind === 'bridge') {
    const width = config.population.bridgeWidth, length = config.terrain.riverWidth * 2.3;
    box(group, [width, 0.35, length], [0, -0.175, 0], PALETTE.timber);
    const planks = Math.ceil(length / 0.65);
    for (let i = 0; i < planks; i++) box(group, [width + 0.08, 0.055, length / planks * 0.87],
      [0, 0.025, -length / 2 + length / planks * (i + 0.5)], i % 2 ? '#ac9170' : '#b39b79');
    for (const side of [-1, 1]) {
      for (const fraction of [-0.46, 0, 0.46]) box(group, [0.2, 1.6, 0.2], [side * width / 2, 0.35, length * fraction], PALETTE.timber);
      box(group, [0.14, 0.14, length + 0.2], [side * width / 2, 0.95, 0], PALETTE.timber);
      box(group, [0.12, 0.12, length], [side * width / 2, 0.45, 0], PALETTE.timber);
    }
  }
  return group;
}

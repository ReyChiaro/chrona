import * as THREE from 'three';
import { PALETTE, type WorldConfig } from '../../protocol/src/config';
import type { ChunkData } from '../../world/src/generator';
import { projectRoads } from './road-geometry';
import { clipWaterTriangle } from '../../world/src/water';
import { columnBottom } from '../../world/src/surface';

export interface ChunkVisual { group: THREE.Group; materials: THREE.Material[]; bornAt: number; data: ChunkData }

function createWater(data: ChunkData, level: number): THREE.BufferGeometry {
  const out: number[] = [];
  type Vertex = { x: number; y: number; z: number };
  for (let i = 0; i < data.indices.length; i += 3) {
    let polygon: Vertex[] = Array.from({ length: 3 }, (_, offset) => {
      const index = data.indices[i + offset] * 3;
      return { x: data.positions[index], y: data.positions[index + 1], z: data.positions[index + 2] };
    });
    polygon = clipWaterTriangle(polygon, level);
    for (let j = 1; j < polygon.length - 1; j++) for (const vertex of [polygon[0], polygon[j], polygon[j + 1]]) out.push(vertex.x, level + 0.025, vertex.z);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function createChunkVisual(data: ChunkData, config: WorldConfig, bornAt: number): ChunkVisual {
  const group = new THREE.Group();
  group.name = `chunk:${data.key}`;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals();
  const groundMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true });
  const ground = new THREE.Mesh(geometry, groundMaterial);
  ground.receiveShadow = true;
  ground.userData.pickRole = 'ground';
  group.add(ground);
  const roadGeometry = new THREE.BufferGeometry();
  roadGeometry.setAttribute('position', new THREE.BufferAttribute(projectRoads(data), 3)); roadGeometry.computeVertexNormals();
  const roadMaterial = new THREE.MeshStandardMaterial({ color: data.roads.some(r => r.template === 'regional-asphalt') ? '#34383e' : PALETTE.road, roughness: 1, flatShading: true, side: THREE.DoubleSide });
  const roads = new THREE.Mesh(roadGeometry, roadMaterial); roads.receiveShadow = true; group.add(roads);
  roads.userData.pickRole = 'ground';

  const sidePositions: number[] = [];
  const bottom = columnBottom(data, config.terrain.columnDepth);
  for (let i = 0; i < data.boundary.length; i++) {
    const a = data.boundary[i], b = data.boundary[(i + 1) % data.boundary.length];
    sidePositions.push(a.x, a.y, a.z, b.x, b.y, b.z, a.x, bottom, a.z,
      b.x, b.y, b.z, b.x, bottom, b.z, a.x, bottom, a.z);
  }
  const sideGeometry = new THREE.BufferGeometry();
  sideGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sidePositions, 3));
  sideGeometry.computeVertexNormals();
  const sideMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.dirt, roughness: 1, flatShading: true, side: THREE.DoubleSide });
  const sides = new THREE.Mesh(sideGeometry, sideMaterial); sides.userData.pickRole = 'wall'; group.add(sides);

  const waterMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.water, roughness: 0.32, metalness: 0.08,
    side: THREE.DoubleSide,
  });
  const water = new THREE.Mesh(createWater(data, config.terrain.waterLevel), waterMaterial); water.userData.pickRole = 'water'; group.add(water);

  const edgeGeometry = new THREE.BufferGeometry().setFromPoints(data.boundary.map(p => new THREE.Vector3(p.x, Math.max(p.y, config.terrain.waterLevel) + 0.07, p.z)));
  const edgeMaterial = new THREE.LineBasicMaterial({ color: PALETTE.hexEdge, transparent: true, opacity: 0.38 });
  const edges = new THREE.LineLoop(edgeGeometry, edgeMaterial);
  edges.name = 'hex-edges';
  edges.visible = config.presentation.showHexEdges;
  group.add(edges);
  return { group, materials: [groundMaterial, roadMaterial, sideMaterial, waterMaterial, edgeMaterial], bornAt, data };
}

export function disposeGroup(group: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  group.traverse(object => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    }
  });
  for (const material of materials) material.dispose();
  group.removeFromParent();
}

import { contentPackageSchema, type ContentPackage } from '../../packages/protocol/src/content';
import { DEFAULT_CONFIG } from '../../packages/protocol/src/config';

export function waterFixture(center = { x: 0, z: -500 }, level = DEFAULT_CONFIG.terrain.waterLevel): ContentPackage {
  return contentPackageSchema.parse({ protocol: 2, id: 'fixture-coast', version: '1.0.0', title: '连续海岸', description: '原生水体验收测试',
    assets: { kelp: { label: '海带', materials: { kelp: { label: '海带', color: '#486b39', roughness: 0.85 } }, parts: [{ shape: 'cylinder', size: [0.2, 2, 0.2], position: [0, 1, 0], material: 'kelp' }], collider: null } },
    region: { center, radius: 120, transition: 28, elevation: level + 3, preserveCorridors: false,
      operators: [{ kind: 'terrace', height: -20, radius: 92, offset: { x: 0, z: 0 } }],
      surface: { color: '#a6946a', snowCover: false }, water: { kind: 'ocean', shoreColor: '#e1cf9b', shoreHeight: 1.2 },
      clearing: { vegetation: true, rocks: true, settlements: true }, requirements: {},
      scatter: [{ asset: 'kelp', count: 100, clearance: 3, habitat: 'underwater' }] } });
}

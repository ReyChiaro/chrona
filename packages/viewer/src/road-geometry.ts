import type { ChunkData } from '../../world/src/generator';

type Vertex = { x: number; y: number; z: number };
const cross = (a: Vertex, b: Vertex, p: Vertex) => (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);

/** Clip road strips to the actual proxy triangles, so decals neither float nor cut through slopes. */
export function projectRoads(data: ChunkData): Float32Array {
  const out: number[] = [];
  if (!data.roads.length) return new Float32Array();
  const triangles = [];
  for (let i = 0; i < data.indices.length; i += 3) {
    const vertices = Array.from({ length: 3 }, (_, j) => {
      const k = data.indices[i + j] * 3;
      return { x: data.positions[k], y: data.positions[k + 1], z: data.positions[k + 2] };
    });
    triangles.push({ vertices, minX: Math.min(...vertices.map(v => v.x)), maxX: Math.max(...vertices.map(v => v.x)),
      minZ: Math.min(...vertices.map(v => v.z)), maxZ: Math.max(...vertices.map(v => v.z)) });
  }
  for (const road of data.roads) for (let i = 1; i < road.points.length; i++) {
    const from = road.points[i - 1], to = road.points[i], length = Math.hypot(to.x - from.x, to.z - from.z);
    if (length < 0.001) continue;
    const nx = -(to.z - from.z) / length * road.width / 2, nz = (to.x - from.x) / length * road.width / 2;
    const strip = [[from, 1], [to, 1], [to, -1], [from, -1]].map(([point, side]) => {
      const p = point as typeof from, sign = side as number;
      return { x: p.x - data.center.x + nx * sign, y: 0, z: p.z - data.center.z + nz * sign };
    });
    const minX = Math.min(...strip.map(v => v.x)), maxX = Math.max(...strip.map(v => v.x));
    const minZ = Math.min(...strip.map(v => v.z)), maxZ = Math.max(...strip.map(v => v.z));
    for (const triangle of triangles) {
      if (maxX < triangle.minX || minX > triangle.maxX || maxZ < triangle.minZ || minZ > triangle.maxZ) continue;
      const [a, b, c] = triangle.vertices, area = cross(a, b, c), sign = Math.sign(area);
      let polygon = strip;
      for (let edge = 0; edge < 3 && polygon.length; edge++) {
        const v = triangle.vertices[edge], w = triangle.vertices[(edge + 1) % 3], clipped: Vertex[] = [];
        for (let j = 0; j < polygon.length; j++) {
          const p = polygon[j], q = polygon[(j + 1) % polygon.length], dp = cross(v, w, p) * sign, dq = cross(v, w, q) * sign;
          if (dp >= -1e-7) clipped.push(p);
          if ((dp >= 0) !== (dq >= 0)) {
            const t = dp / (dp - dq);
            clipped.push({ x: p.x + (q.x - p.x) * t, y: 0, z: p.z + (q.z - p.z) * t });
          }
        }
        polygon = clipped;
      }
      for (const p of polygon) {
        const wa = cross(b, c, p) / area, wb = cross(c, a, p) / area;
        p.y = a.y * wa + b.y * wb + c.y * (1 - wa - wb) + 0.035;
      }
      for (let j = 1; j < polygon.length - 1; j++) for (const p of [polygon[0], polygon[j], polygon[j + 1]]) out.push(p.x, p.y, p.z);
    }
  }
  return new Float32Array(out);
}

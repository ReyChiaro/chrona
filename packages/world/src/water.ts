/** All views use the same world-space sea level and terrain/plane intersection. */
export interface WaterVertex { x: number; y: number; z: number }
export function clipWaterTriangle(vertices: WaterVertex[], level: number): WaterVertex[] {
  const polygon: WaterVertex[] = [];
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    if (a.y <= level) polygon.push({ x: a.x, y: level, z: a.z });
    if ((a.y <= level) !== (b.y <= level)) {
      const t = (level - a.y) / (b.y - a.y);
      polygon.push({ x: a.x + (b.x - a.x) * t, y: level, z: a.z + (b.z - a.z) * t });
    }
  }
  return polygon;
}
export function polygonArea(vertices: WaterVertex[]): number {
  return Math.abs(vertices.reduce((sum, a, i) => { const b = vertices[(i + 1) % vertices.length]; return sum + a.x * b.z - b.x * a.z; }, 0)) / 2;
}

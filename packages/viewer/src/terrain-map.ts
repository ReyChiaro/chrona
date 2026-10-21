import type { WorldConfig } from '../../protocol/src/config';
import type { ChunkData } from '../../world/src/generator';
import { resolvePartMaterial } from '../../protocol/src/materials';
import { clipWaterTriangle } from '../../world/src/water';

type Vertex = { x: number; y: number; z: number };

/** Intersections of horizontal elevation planes with the actual proxy triangles. */
export function triangleContours(vertices: Vertex[], interval: number, waterLevel: number): [Vertex, Vertex][] {
  const result: [Vertex, Vertex][] = [];
  const low = Math.max(waterLevel, Math.min(...vertices.map(v => v.y)));
  const high = Math.max(...vertices.map(v => v.y));
  for (let height = Math.ceil(low / interval) * interval; height < high; height += interval) {
    const hits: Vertex[] = [];
    for (let i = 0; i < 3; i++) {
      const a = vertices[i], b = vertices[(i + 1) % 3];
      if ((a.y <= height && b.y > height) || (b.y <= height && a.y > height)) {
        const t = (height - a.y) / (b.y - a.y);
        hits.push({ x: a.x + t * (b.x - a.x), y: height, z: a.z + t * (b.z - a.z) });
      }
    }
    if (hits.length === 2) result.push([hits[0], hits[1]]);
  }
  return result;
}

const srgb = (linear: number) => Math.round(255 * Math.max(0, Math.min(1, linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055)));

export function createTerrainMapTile(data: ChunkData, config: WorldConfig, pixels = 256) {
  const radius = config.chunkRadius, scale = pixels / (radius * 2);
  const terrain = document.createElement('canvas'), contours = document.createElement('canvas');
  terrain.width = terrain.height = contours.width = contours.height = pixels;
  const ctx = terrain.getContext('2d')!, lines = contours.getContext('2d')!;
  const waterPolygons: Vertex[][] = [];
  for (const context of [ctx, lines]) { context.translate(pixels / 2, pixels / 2); context.scale(scale, scale); }
  const path = (context: CanvasRenderingContext2D, points: Vertex[]) => {
    context.beginPath(); points.forEach((v, i) => i ? context.lineTo(v.x, v.z) : context.moveTo(v.x, v.z)); context.closePath();
  };
  for (let i = 0; i < data.indices.length; i += 3) {
    const indices = Array.from(data.indices.slice(i, i + 3));
    const vertices = indices.map(j => ({ x: data.positions[j * 3], y: data.positions[j * 3 + 1], z: data.positions[j * 3 + 2] }));
    const [a, b, c] = vertices;
    const nx = (b.y - a.y) * (c.z - a.z) - (b.z - a.z) * (c.y - a.y);
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const length = Math.hypot(nx, ny, nz) || 1;
    const shade = 0.7 + 0.4 * Math.max(0, (nx * -0.4 + ny * 0.8 + nz * -0.3) / length);
    const color = [0, 1, 2].map(channel => srgb(indices.reduce((sum, j) => sum + data.colors[j * 3 + channel], 0) / 3 * shade));
    path(ctx, vertices); ctx.fillStyle = ctx.strokeStyle = `rgb(${color.join(',')})`; ctx.lineWidth = 0.15; ctx.fill(); ctx.stroke();
    const water = clipWaterTriangle(vertices, config.terrain.waterLevel);
    if (water.length >= 3) waterPolygons.push(water);
    lines.strokeStyle = '#4d604a80'; lines.lineWidth = 0.15;
    for (const [v, next] of triangleContours(vertices, config.presentation.contourInterval, config.terrain.waterLevel)) {
      lines.beginPath(); lines.moveTo(v.x, v.z); lines.lineTo(next.x, next.z); lines.stroke();
    }
  }
  ctx.fillStyle = ctx.strokeStyle = '#73aeb7'; ctx.lineWidth = 0.2;
  for (const polygon of waterPolygons) { path(ctx, polygon); ctx.fill(); ctx.stroke(); }
  ctx.strokeStyle = '#cbb795'; ctx.lineJoin = ctx.lineCap = 'round';
  for (const road of data.roads) {
    ctx.strokeStyle = road.template === 'regional-asphalt' ? '#34383e' : '#cbb795';
    ctx.lineWidth = road.width; ctx.beginPath();
    road.points.forEach((point, i) => i ? ctx.lineTo(point.x - data.center.x, point.z - data.center.z) : ctx.moveTo(point.x - data.center.x, point.z - data.center.z));
    ctx.stroke();
  }
  // Features use the same stable coordinates and dimensions as the 3D world.
  for (const asset of data.assets) {
    const x = asset.x - data.center.x, z = asset.z - data.center.z;
    ctx.save(); ctx.translate(x, z); ctx.rotate(-asset.rotation);
    if (asset.design) {
      ctx.fillStyle = resolvePartMaterial(asset.design, asset.design.parts.at(-1)!).color; ctx.beginPath(); ctx.arc(0, 0, 2.7 * asset.scale, 0, Math.PI * 2); ctx.fill();
    } else if (asset.kind === 'house') {
      const width = config.population.houseWidth * asset.scale;
      ctx.fillStyle = '#785b43'; ctx.fillRect(-width / 2 - 0.3, -width * 0.42 - 0.3, width + 0.6, width * 0.84 + 0.6);
      ctx.fillStyle = asset.variant > 0.5 ? '#b17957' : '#897762'; ctx.fillRect(-width / 2, -width * 0.42, width, width * 0.84);
    } else if (asset.kind === 'bridge') {
      ctx.fillStyle = '#ae8758'; ctx.fillRect(-config.population.bridgeWidth / 2, -config.terrain.riverWidth * 1.15, config.population.bridgeWidth, config.terrain.riverWidth * 2.3);
    } else {
      ctx.fillStyle = asset.kind === 'pine' ? '#386f48' : asset.kind === 'birch' ? '#71954a' : asset.kind === 'rock' ? '#8c9186' : '#7f9b52';
      ctx.beginPath(); ctx.arc(0, 0, asset.scale * (asset.kind === 'shrub' ? 0.6 : 1.1), 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // Prevent objects crossing a boundary from painting over their neighboring map tile.
  ctx.save(); ctx.globalCompositeOperation = 'destination-in';
  ctx.beginPath(); data.boundary.forEach((v, i) => i ? ctx.lineTo(v.x, v.z) : ctx.moveTo(v.x, v.z)); ctx.closePath(); ctx.fill(); ctx.restore();
  return { terrain, contours };
}

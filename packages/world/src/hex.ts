export interface Hex {
  q: number;
  r: number;
}
export interface Point2 {
  x: number;
  z: number;
}

const DIRECTIONS: readonly Hex[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

export const hexKey = ({ q, r }: Hex): string => `${q},${r}`;
export const parseHexKey = (key: string): Hex => {
  const [q, r] = key.split(",").map(Number);
  if (!Number.isSafeInteger(q) || !Number.isSafeInteger(r))
    throw new Error("Invalid hex coordinate");
  return { q, r };
};
export const hexDistance = (a: Hex, b: Hex): number =>
  Math.max(
    Math.abs(a.q - b.q),
    Math.abs(a.r - b.r),
    Math.abs(a.q + a.r - b.q - b.r),
  );
export const hexCenter = ({ q, r }: Hex, radius: number): Point2 => ({
  x: Math.sqrt(3) * radius * (q + r / 2),
  z: 1.5 * radius * r,
});

export function worldToHex(x: number, z: number, radius: number): Hex {
  const q = ((Math.sqrt(3) * x) / 3 - z / 3) / radius;
  const r = (2 * z) / 3 / radius;
  let rq = Math.round(q),
    rr = Math.round(r),
    rs = Math.round(-q - r);
  const dq = Math.abs(rq - q),
    dr = Math.abs(rr - r),
    ds = Math.abs(rs + q + r);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: Object.is(rq, -0) ? 0 : rq, r: Object.is(rr, -0) ? 0 : rr };
}

/** Range includes the center: one layer = 1 cell, two layers = 7 cells. */
export function hexDisk(center: Hex, range: number): Hex[] {
  const radius = Math.max(0, Math.floor(range) - 1);
  const cells: Hex[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (
      let r = Math.max(-radius, -q - radius);
      r <= Math.min(radius, -q + radius);
      r++
    ) {
      cells.push({ q: center.q + q, r: center.r + r });
    }
  }
  return cells.sort(
    (a, b) =>
      hexDistance(a, center) - hexDistance(b, center) || a.q - b.q || a.r - b.r,
  );
}

export const hexNeighbors = (cell: Hex): Hex[] =>
  DIRECTIONS.map((d) => ({ q: cell.q + d.q, r: cell.r + d.r }));
export function hexCorners(cell: Hex, radius: number): Point2[] {
  const center = hexCenter(cell, radius);
  return Array.from({ length: 6 }, (_, i) => {
    const angle = Math.PI / 6 + (i * Math.PI) / 3;
    return {
      x: snap(center.x + Math.cos(angle) * radius),
      z: snap(center.z + Math.sin(angle) * radius),
    };
  });
}
export const snap = (value: number): number => Math.round(value * 1e6) / 1e6;

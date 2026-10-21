import type { ChunkData } from "./generator";

/** Keep decorative columns below deep authored seabeds without changing terrain or physics. */
export function columnBottom(
  chunk: Pick<ChunkData, "positions">,
  depth: number,
): number {
  let low = Infinity;
  for (let i = 1; i < chunk.positions.length; i += 3)
    low = Math.min(low, chunk.positions[i]);
  return low < -depth ? low - depth : -depth;
}

/** Sample the same triangle surface used by Rapier, including content operators. */
export function surfaceHeight(
  chunk: ChunkData,
  x: number,
  z: number,
): number | undefined {
  x -= chunk.center.x;
  z -= chunk.center.z;
  const p = chunk.positions;
  for (let i = 0; i < chunk.indices.length; i += 3) {
    const [a, b, c] = Array.from(chunk.indices.slice(i, i + 3)).map(
      (v) => v * 3,
    );
    const denominator =
      (p[b + 2] - p[c + 2]) * (p[a] - p[c]) +
      (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
    const wa =
      ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) /
      denominator;
    const wb =
      ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) /
      denominator;
    if (wa >= -1e-6 && wb >= -1e-6 && wa + wb <= 1 + 1e-6)
      return wa * p[a + 1] + wb * p[b + 1] + (1 - wa - wb) * p[c + 1];
  }
}

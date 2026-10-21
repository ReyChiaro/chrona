export interface SplinePoint {
  at: number;
  value: number;
  derivative: number;
}
export type Spline = readonly SplinePoint[];

export const clamp01 = (value: number): number =>
  Math.max(0, Math.min(1, value));
export const mix = (a: number, b: number, weight: number): number =>
  a + (b - a) * weight;
/** Quintic easing has zero first and second derivatives at either end. */
export function smoothRange(from: number, to: number, value: number): number {
  const t = clamp01((value - from) / (to - from));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Cubic Hermite interpolation, with explicit endpoint slopes in signal space. */
export function sampleSpline(points: Spline, value: number): number {
  if (value <= points[0].at) return points[0].value;
  const last = points[points.length - 1];
  if (value >= last.at) return last.value;
  let index = 1;
  while (points[index].at < value) index++;
  const a = points[index - 1],
    b = points[index],
    width = b.at - a.at;
  const t = (value - a.at) / width,
    t2 = t * t,
    t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * a.value +
    (t3 - 2 * t2 + t) * width * a.derivative +
    (-2 * t3 + 3 * t2) * b.value +
    (t3 - t2) * width * b.derivative
  );
}

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

export function randomAt(seed: string, layer: string, x: number, z: number): number {
  let hash = hashString(`${seed}:${layer}:${x}:${z}`);
  hash = Math.imul(hash ^ hash >>> 16, 0x21f0aaad);
  hash = Math.imul(hash ^ hash >>> 15, 0x735a2d97);
  return ((hash ^ hash >>> 15) >>> 0) / 4294967296;
}

const smooth = (value: number) => value * value * (3 - 2 * value);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function noise(seed: string, layer: string, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = smooth(x - ix), fz = smooth(z - iz);
  return mix(
    mix(randomAt(seed, layer, ix, iz), randomAt(seed, layer, ix + 1, iz), fx),
    mix(randomAt(seed, layer, ix, iz + 1), randomAt(seed, layer, ix + 1, iz + 1), fx), fz,
  ) * 2 - 1;
}

// A bounded cache of immutable salts; terrain coordinates and generated chunks are never cached here.
const salts = new Map<string, number>();
function layerSalt(seed: string, layer: string): number {
  const key = `${seed}:${layer}`;
  let salt = salts.get(key);
  if (salt === undefined) {
    salt = hashString(key);
    if (salts.size >= 128) salts.delete(salts.keys().next().value!);
    salts.set(key, salt);
  }
  return salt;
}

const diagonal = Math.SQRT1_2;
const gradients = [[1, 0], [-1, 0], [0, 1], [0, -1], [diagonal, diagonal], [-diagonal, diagonal], [diagonal, -diagonal], [-diagonal, -diagonal]] as const;

/** Seeded 2D Perlin gradient noise with a C2 interpolation kernel. */
export function gradientNoise(seed: string, layer: string, x: number, z: number): number {
  const salt = layerSalt(seed, layer);
  // Shift each field away from the integer lattice, including at the world origin.
  x += (salt & 65535) / 257; z += (salt >>> 16) / 263;
  const ix = Math.floor(x), iz = Math.floor(z), dx = x - ix, dz = z - iz;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const dot = (gx: number, gz: number) => {
    let hash = salt ^ Math.imul(gx, 0x1f123bb5) ^ Math.imul(gz, 0x5f356495);
    hash = Math.imul(hash ^ hash >>> 16, 0x21f0aaad);
    hash = Math.imul(hash ^ hash >>> 15, 0x735a2d97);
    const gradient = gradients[(hash ^ hash >>> 15) & 7];
    return gradient[0] * (x - gx) + gradient[1] * (z - gz);
  };
  return mix(mix(dot(ix, iz), dot(ix + 1, iz), fade(dx)), mix(dot(ix, iz + 1), dot(ix + 1, iz + 1), fade(dx)), fade(dz)) * Math.SQRT2;
}

export function octaveNoise(seed: string, layer: string, x: number, z: number, octaves = 3): number {
  let value = 0, weight = 1, total = 0;
  for (let octave = 0; octave < octaves; octave++) {
    value += gradientNoise(seed, `${layer}:${octave}`, x, z) * weight;
    total += weight; weight *= 0.45; x *= 2; z *= 2;
  }
  return value / total;
}

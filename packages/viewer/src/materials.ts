import * as THREE from "three";
import type {
  MaterialDefinition,
  SurfaceTexture,
} from "../../protocol/src/materials";

const SIZE = 128;
const fraction = (n: number): number => n - Math.floor(n);
const noise = (x: number, y: number, seed: number): number => {
  let n = Math.imul(x ^ seed, 374761393) ^ Math.imul(y + 1, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};

/** Small deterministic tile generated from literals. Never fetches image URLs. */
export function surfacePixels(spec: SurfaceTexture): Uint8Array {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const u = x / SIZE,
        v = y / SIZE;
      let value = noise(x, y, spec.seed);
      if (spec.pattern === "wood")
        value =
          0.5 +
          Math.sin(
            (u * 8 + Math.sin(v * Math.PI * 2) * 0.12 + (spec.seed % 29) / 29) *
              Math.PI *
              2,
          ) *
            0.35 +
          (value - 0.5) * 0.2;
      if (spec.pattern === "stone")
        value =
          noise(Math.floor(x / 12), Math.floor(y / 12), spec.seed) * 0.55 +
          value * 0.45;
      if (spec.pattern === "brick") {
        const row = Math.floor(v * 4),
          edgeX = fraction(u * 4 + (row % 2) * 0.5),
          edgeY = fraction(v * 4);
        value = edgeX < 0.07 || edgeY < 0.12 ? 0.05 : 0.6 + value * 0.3;
      }
      if (spec.pattern === "fabric")
        value =
          0.5 +
          Math.sin(u * Math.PI * 32) * Math.sin(v * Math.PI * 32) * 0.35 +
          (value - 0.5) * 0.15;
      const channel = Math.round(
        255 *
          (1 - spec.contrast + Math.max(0, Math.min(1, value)) * spec.contrast),
      );
      const i = (y * SIZE + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = channel;
      pixels[i + 3] = 255;
    }
  return pixels;
}

export function createSurfaceMaterial(
  spec: MaterialDefinition,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    name: spec.label,
    color: spec.color,
    roughness: spec.roughness,
    metalness: spec.metalness ?? 0,
    opacity: spec.opacity ?? 1,
    transparent: (spec.opacity ?? 1) < 1,
    depthWrite: (spec.opacity ?? 1) >= 1,
    emissive: spec.emissive ?? "#000000",
    emissiveIntensity: spec.emissiveIntensity ?? 1,
    flatShading: spec.flatShading ?? true,
  });
  if (spec.texture) {
    const texture = new THREE.DataTexture(
      surfacePixels(spec.texture),
      SIZE,
      SIZE,
      THREE.RGBAFormat,
    );
    texture.name = `${spec.label}:${spec.texture.pattern}:${spec.texture.seed}`;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(...spec.texture.repeat);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    // Grayscale multipliers are linear data; color itself is decoded by THREE.Color.
    material.map = texture;
    if (spec.texture.bump > 0) {
      material.bumpMap = texture;
      material.bumpScale = spec.texture.bump;
    }
    material.addEventListener("dispose", () => texture.dispose());
  }
  return material;
}

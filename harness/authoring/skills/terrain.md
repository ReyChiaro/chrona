# Terrain authoring protocol v1

Terrain extensions declare amplitude (0–12 m), wavelength (30–300 m), tint and optional asset scatter. The engine applies a smooth zero border to each hex, preserving the original boundary. Roads, foundations and river channels retain their supporting surface. No arbitrary height callbacks. New recipes apply only to unexplored chunks; old chunk version pins never change. Terrain and the Rapier triangle mesh must agree. Validation checks neighbouring cells, seam samples, finite geometry and deterministic regeneration. This bounded operator is intentionally narrower than an unrestricted terrain generator.

For a new biome, mountain range, volcano or city, use protocol:2 and read regions. This legacy operator is retained for compatibility and minor overlays, not new regional scene generation.

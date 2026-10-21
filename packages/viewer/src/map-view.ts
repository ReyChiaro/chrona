import { LocalizedError } from "../../i18n/src/index";
import { msg } from "../../i18n/src/index";
import type { WorldReadModel as WorldRuntime } from "../../world/src/ports/read-model";
import { PALETTE } from "../../protocol/src/config";
import { hexCenter, hexCorners, hexKey, worldToHex } from "../../world/src/hex";
import { groundColor } from "../../world/src/generator";
import { terrainHeight } from "../../world/src/terrain";
import { createTerrainMapTile } from "./terrain-map";

type Tile = ReturnType<typeof createTerrainMapTile>;

export class MapView {
  private contentRevision = -1;
  private context: CanvasRenderingContext2D;
  private scale = 1;
  private center = { x: 0, z: 0 };
  private drag: { x: number; y: number } | null = null;
  private observer: ResizeObserver;
  private abort = new AbortController();
  private tiles = new Map<string, Tile>();
  private count = -1;
  private interval = -1;
  mode: "all" | "follow" | "free" = "all";

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly runtime: WorldRuntime,
    readonly onInspect: (text: string) => void,
  ) {
    const context = canvas.getContext("2d");
    if (!context)
      throw new LocalizedError("viewer.map-view.cannot-create-the-map-canvas");
    this.context = context;
    const { signal } = this.abort;
    canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.mode = "free";
        this.scale = Math.max(
          0.00001,
          Math.min(20, this.scale * Math.exp(-event.deltaY * 0.001)),
        );
      },
      { passive: false, signal },
    );
    canvas.addEventListener(
      "pointerdown",
      (event) => {
        this.drag = { x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
      },
      { signal },
    );
    canvas.addEventListener("pointerup", () => (this.drag = null), { signal });
    canvas.addEventListener("pointercancel", () => (this.drag = null), {
      signal,
    });
    canvas.addEventListener(
      "pointermove",
      (event) => {
        if (this.drag) {
          this.mode = "free";
          this.center.x -= (event.clientX - this.drag.x) / this.scale;
          this.center.z -= (event.clientY - this.drag.y) / this.scale;
          this.drag = { x: event.clientX, y: event.clientY };
        }
        const rect = canvas.getBoundingClientRect();
        const x =
          (event.clientX - rect.left - rect.width / 2) / this.scale +
          this.center.x;
        const z =
          (event.clientY - rect.top - rect.height / 2) / this.scale +
          this.center.z;
        const key = hexKey(worldToHex(x, z, runtime.config.chunkRadius));
        const label = `${key} · ${runtime.chunks.active.has(key) ? msg("viewer.map-view.loaded") : runtime.chunks.records.has(key) ? msg("viewer.map-view.generated") : msg("viewer.map-view.not-generated")}`;
        onInspect(label);
        canvas.title = msg("viewer.map-view.drag-to-pan-scroll-to-zoom", {
          p0: label,
        });
      },
      { signal },
    );
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas.parentElement!);
    this.resize();
  }

  private resize(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect(),
      ratio = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    if (this.mode === "all") this.fitWorld();
  }

  focus(): void {
    this.mode = "follow";
    this.center = { x: this.runtime.camera.x, z: this.runtime.camera.z };
    const rect = this.canvas.getBoundingClientRect();
    this.scale =
      Math.min(rect.width, rect.height) /
      (this.runtime.config.chunkRadius *
        (this.runtime.config.loadRange * 3 + 1));
  }

  fitWorld(): void {
    const radius = this.runtime.config.chunkRadius;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (const record of this.runtime.chunks.records.values()) {
      if (record.visits === 0) continue;
      const p = hexCenter(record, radius);
      minX = Math.min(minX, p.x - radius);
      maxX = Math.max(maxX, p.x + radius);
      minZ = Math.min(minZ, p.z - radius);
      maxZ = Math.max(maxZ, p.z + radius);
    }
    if (!Number.isFinite(minX)) return;
    this.center = { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
    const rect = this.canvas.getBoundingClientRect();
    this.scale =
      Math.min(rect.width / (maxX - minX), rect.height / (maxZ - minZ)) * 0.93;
    this.count = this.runtime.chunks.records.size;
    this.mode = "all";
  }

  render(): void {
    if (this.contentRevision !== this.runtime.content.state.revision) {
      this.tiles.clear();
      this.contentRevision = this.runtime.content.state.revision;
    }
    const ctx = this.context,
      rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = this.canvas.width / rect.width,
      width = rect.width,
      height = rect.height;
    if (this.mode === "all" && this.count !== this.runtime.chunks.records.size)
      this.fitWorld();
    if (this.mode === "follow")
      this.center = { x: this.runtime.camera.x, z: this.runtime.camera.z };
    if (this.interval !== this.runtime.config.presentation.contourInterval) {
      this.tiles.clear();
      this.interval = this.runtime.config.presentation.contourInterval;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = "#eef1e8";
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-this.center.x, -this.center.z);
    const radius = this.runtime.config.chunkRadius;
    let prepared = 0;
    for (const [key, cell] of this.runtime.chunks.records) {
      if (cell.visits === 0) continue;
      const center = hexCenter(cell, radius);
      if (
        Math.abs(center.x - this.center.x) >
          width / (2 * this.scale) + radius ||
        Math.abs(center.z - this.center.z) > height / (2 * this.scale) + radius
      )
        continue;
      const detailed = radius * this.scale >= 6;
      const pixels = radius * this.scale >= 16 ? 256 : 96;
      let tile = detailed ? this.tiles.get(key) : undefined;
      if (detailed && (!tile || tile.terrain.width < pixels) && prepared < 3) {
        tile = createTerrainMapTile(
          this.runtime.chunks.active.get(key) ??
            this.runtime.content.generate(cell, this.runtime.config, cell),
          this.runtime.config,
          pixels,
        );
        this.tiles.set(key, tile);
        prepared++;
        while (this.tiles.size > 512)
          this.tiles.delete(this.tiles.keys().next().value!);
      }
      if (tile) {
        ctx.drawImage(
          tile.terrain,
          center.x - radius,
          center.z - radius,
          radius * 2,
          radius * 2,
        );
        if (this.runtime.config.presentation.mapContours)
          ctx.drawImage(
            tile.contours,
            center.x - radius,
            center.z - radius,
            radius * 2,
            radius * 2,
          );
      }
      const points = hexCorners(cell, radius);
      ctx.beginPath();
      points.forEach((p, i) =>
        i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z),
      );
      ctx.closePath();
      if (!tile) {
        const elevation = terrainHeight(
          center.x,
          center.z,
          this.runtime.config,
        );
        const color = groundColor(
          center.x,
          center.z,
          elevation,
          this.runtime.config,
        ).map((value) =>
          Math.round(
            (value <= 0.0031308
              ? value * 12.92
              : 1.055 * value ** (1 / 2.4) - 0.055) * 255,
          ),
        );
        ctx.fillStyle =
          elevation < this.runtime.config.terrain.waterLevel
            ? PALETTE.water
            : `rgb(${color.join(",")})`;
        ctx.fill();
      }
      const loaded = this.runtime.chunks.active.has(key);
      ctx.strokeStyle = loaded ? "#e1ffb0" : "#61725845";
      ctx.lineWidth = (loaded ? 1.6 : 0.5) / this.scale;
      ctx.shadowColor = loaded ? "#b3ed6e" : "transparent";
      ctx.shadowBlur = loaded ? 5 : 0;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    if (
      this.runtime.config.presentation.showMapTrail &&
      this.runtime.trail.length > 1
    ) {
      ctx.beginPath();
      this.runtime.trail.forEach((p, i) =>
        i ? ctx.lineTo(p.x, p.z) : ctx.moveTo(p.x, p.z),
      );
      ctx.strokeStyle = PALETTE.trail;
      ctx.lineWidth = 2 / this.scale;
      ctx.lineJoin = "round";
      ctx.stroke();
    }
    const p = this.runtime.camera,
      size = 6 / this.scale;
    ctx.save();
    ctx.translate(p.x, p.z);
    ctx.rotate(-p.yaw);
    ctx.beginPath();
    ctx.moveTo(0, -size * 1.4);
    ctx.lineTo(-size * 0.8, size);
    ctx.lineTo(0, size * 0.55);
    ctx.lineTo(size * 0.8, size);
    ctx.closePath();
    ctx.fillStyle = PALETTE.player;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.6 / this.scale;
    ctx.stroke();
    ctx.restore();
    ctx.restore();
    const meters = 10 ** Math.floor(Math.log10(90 / this.scale));
    ctx.strokeStyle = "#566c4d";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(16, height - 12);
    ctx.lineTo(16 + meters * this.scale, height - 12);
    ctx.stroke();
    ctx.fillStyle = "#566c4d";
    ctx.font = "9px ui-monospace,monospace";
    ctx.fillText(`${meters} m`, 16, height - 17);
    this.canvas.dataset.renderedChunks = String(this.tiles.size);
    this.canvas.dataset.generatedChunks = String(
      this.runtime.chunks.records.size,
    );
    this.canvas.dataset.contours = String(
      this.runtime.config.presentation.mapContours,
    );
  }

  dispose(): void {
    this.observer.disconnect();
    this.abort.abort();
    this.tiles.clear();
  }
}

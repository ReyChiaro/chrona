import { projectWorld } from "../../proxy/src/projection";
import * as THREE from "three";
import type { ContextObject, SceneContext } from "../../protocol/src/content";
import { assetAppearance as appearanceOf } from "../../protocol/src/materials";
import type { WorldReadModel as WorldRuntime } from "../../world/src/ports/read-model";
import { hashString } from "../../world/src/random";
import { hexKey, worldToHex } from "../../world/src/hex";

export interface ContextBudget {
  near: number;
  middle: number;
  far: number;
}
export function collectContext(
  runtime: WorldRuntime,
  camera: THREE.PerspectiveCamera,
  time: number,
  budgets: ContextBudget = { near: 12, middle: 8, far: 4 },
): SceneContext {
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    ),
  );
  const candidates: ContextObject[] = [];
  const proxy = projectWorld(runtime);
  for (const a of proxy.assets) {
    const height = a.design
      ? Math.max(...a.design.parts.map((p) => p.position[1] + p.size[1] / 2)) *
        a.scale
      : a.kind === "house"
        ? runtime.config.population.houseHeight * a.scale
        : runtime.config.population.treeHeight * a.scale;
    const pos = new THREE.Vector3(
      a.x - runtime.origin.x,
      a.y + height / 2,
      a.z - runtime.origin.z,
    );
    if (!frustum.intersectsSphere(new THREE.Sphere(pos, height * 0.65)))
      continue;
    const distance = Math.hypot(a.x - runtime.camera.x, a.z - runtime.camera.z);
    const corners = [-1, 1].flatMap((dx) =>
      [-1, 1].flatMap((dy) =>
        [-1, 1].map((dz) =>
          pos
            .clone()
            .add(
              new THREE.Vector3(
                dx * height * 0.4,
                (dy * height) / 2,
                dz * height * 0.4,
              ),
            )
            .project(camera),
        ),
      ),
    );
    const xs = corners.map((p) => (p.x + 1) / 2),
      ys = corners.map((p) => (1 - p.y) / 2);
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const bounds: ContextObject["bounds"] = [
      clamp(Math.min(...xs)),
      clamp(Math.min(...ys)),
      clamp(Math.max(...xs)),
      clamp(Math.max(...ys)),
    ];
    const constraint = runtime.content.state.constraints.find(
      (c) => c.objectId === a.id,
    );
    candidates.push({
      id: a.id,
      kind: a.role === "vehicle" ? "moving-vehicle" : a.kind,
      label: a.design?.label ?? a.kind,
      distance: Math.round(distance),
      band: distance < 35 ? "near" : distance < 100 ? "middle" : "far",
      position: { x: a.x, y: a.y, z: a.z },
      bounds,
      appearance: appearanceOf(a.design),
      stateHash: hashString(
        JSON.stringify({
          asset: a,
          constraint,
          version: runtime.editor.version(a.id),
        }),
      ).toString(16),
      constraint,
    });
  }
  for (const entity of proxy.entities) {
    const p = entity.position,
      position = new THREE.Vector3(
        p.x - runtime.origin.x,
        p.y,
        p.z - runtime.origin.z,
      );
    if (
      !frustum.intersectsSphere(
        new THREE.Sphere(position, entity.halfExtent * 1.8),
      )
    )
      continue;
    const distance = Math.hypot(p.x - runtime.camera.x, p.z - runtime.camera.z);
    const corners = [-1, 1].flatMap((dx) =>
      [-1, 1].flatMap((dy) =>
        [-1, 1].map((dz) =>
          position
            .clone()
            .add(
              new THREE.Vector3(dx, dy, dz).multiplyScalar(
                entity.halfExtent * 1.8,
              ),
            )
            .project(camera),
        ),
      ),
    );
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const bounds: ContextObject["bounds"] = [
      clamp(Math.min(...corners.map((p) => (p.x + 1) / 2))),
      clamp(Math.min(...corners.map((p) => (1 - p.y) / 2))),
      clamp(Math.max(...corners.map((p) => (p.x + 1) / 2))),
      clamp(Math.max(...corners.map((p) => (1 - p.y) / 2))),
    ];
    const constraint = runtime.content.state.constraints.find(
      (c) => c.objectId === entity.id,
    );
    candidates.push({
      id: entity.id,
      kind: "dynamic-crate",
      label: "physical wooden crate",
      distance: Math.round(distance),
      band: distance < 35 ? "near" : distance < 100 ? "middle" : "far",
      position: { ...p },
      bounds,
      constraint,
      stateHash: hashString(
        JSON.stringify({
          id: entity.id,
          position: Object.values(p).map((v) => Math.round(v * 50)),
          rotation: Object.values(entity.rotation).map((v) =>
            Math.round(v * 100),
          ),
          constraint,
          version: runtime.editor.version(entity.id),
        }),
      ).toString(16),
    });
  }
  candidates.sort(
    (a, b) =>
      Number(Boolean(b.constraint)) - Number(Boolean(a.constraint)) ||
      a.distance - b.distance ||
      a.id.localeCompare(b.id),
  );
  const counts = { near: 0, middle: 0, far: 0 };
  const objects = candidates.filter((a) => counts[a.band]++ < budgets[a.band]);
  const cameraChunk = runtime.chunks.active.get(
    hexKey(
      worldToHex(
        runtime.camera.x,
        runtime.camera.z,
        runtime.config.chunkRadius,
      ),
    ),
  );
  const regionalWeather = runtime.content
    .regionalWeather(runtime.chunks.active.values())
    .filter((p) =>
      cameraChunk?.contentPackages?.includes(`${p.id}@${p.version}`),
    );
  return {
    evidenceLevel: "frustum-candidates",
    observerTime: runtime.observation().observerTime,
    time,
    worldId: runtime.id,
    tick: runtime.clock.tick,
    worldSeconds: runtime.clock.elapsedSeconds,
    revision: runtime.content.state.revision,
    camera: { ...runtime.camera },
    objects,
    distantChunks: [...runtime.chunks.active.values()]
      .map((c) => ({
        key: c.key,
        fingerprint: c.fingerprint,
        biome: c.biome,
        visible: frustum.intersectsSphere(
          new THREE.Sphere(
            new THREE.Vector3(
              c.center.x - runtime.origin.x,
              c.positions[1],
              c.center.z - runtime.origin.z,
            ),
            runtime.config.chunkRadius * 2,
          ),
        ),
        distance: Math.round(
          Math.hypot(
            c.center.x - runtime.camera.x,
            c.center.z - runtime.camera.z,
          ),
        ),
        elevation: Math.round(c.positions[1]),
        contentPackages: c.contentPackages ?? [],
      }))
      .slice(0, 19),
    budgets,
    omitted: candidates.length - objects.length,
    environment: {
      hour: runtime.clock.hour,
      paused: runtime.clock.paused,
      waterLevel: runtime.config.terrain.waterLevel,
    },
    weather: [...runtime.content.weatherPackages, ...regionalWeather].map(
      (p) => ({ ...p.weather!, package: `${p.id}@${p.version}` }),
    ),
    regions: runtime.content.state.packages
      .filter(
        (p) =>
          p.region &&
          Math.hypot(
            p.region.center.x - runtime.camera.x,
            p.region.center.z - runtime.camera.z,
          ) <
            p.region.radius +
              runtime.config.chunkRadius * runtime.config.loadRange,
      )
      .map((p) => ({
        key: `${p.id}@${p.version}`,
        title: p.title,
        center: p.region!.center,
        radius: p.region!.radius,
        features: [
          ...p.region!.operators.map((op) => op.kind),
          ...(p.region!.water
            ? [p.region!.water.kind, "native-water", "shoreline"]
            : []),
          ...(p.region!.surface.snowCover ? ["snow-covered"] : []),
          ...(p.region!.roads.length ? ["roads"] : []),
          ...(p.region!.vehicles.length ? ["moving-vehicles"] : []),
        ],
      })),
    edits: runtime.content.state.events
      .filter(
        (e) =>
          runtime.clock.elapsedSeconds - e.worldSeconds < 120 &&
          Math.hypot(
            e.position.x - runtime.camera.x,
            e.position.z - runtime.camera.z,
          ) <
            runtime.config.chunkRadius * runtime.config.loadRange * 3,
      )
      .slice(-24)
      .map((event) => {
        const history = runtime.content.state.history.find(
          (entry) => entry.id === event.id,
        );
        const change = history?.changes.find(
          (item) => item.id === event.objectId,
        );
        const asset =
          change?.before.resolved ??
          change?.before.patch ??
          change?.before.addition;
        return {
          ...event,
          subject: asset
            ? {
                kind: asset.kind,
                label: asset.design?.label ?? asset.kind,
                appearance: appearanceOf(asset.design),
              }
            : undefined,
        };
      }),
  };
}

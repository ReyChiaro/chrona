import { msg } from "../../i18n/src/index";
import type { ContentPackage } from "../../protocol/src/content";
import type { RegionReport, RegionRecipe } from "../../protocol/src/regions";
import type { WorldConfig } from "../../protocol/src/config";
import type { Asset, ChunkData } from "./generator";
import type { WorldContent } from "./content";
import { hexKey, worldToHex } from "./hex";
import {
  nearbyProtected,
  regionCells,
  regionKey,
  regionRoads,
  regionWeight,
} from "./regions";
import { surfaceHeight } from "./surface";
import { segmentDistance } from "./road-planning";
import { vehiclePose } from "./traffic";
import {
  measureRegionWater,
  requestsWater,
  waterTileAssets,
} from "./water-validation";

/** Conservative explicit-feature floors supplement, never weaken, the agent's declared criteria. */
export function requestedCriteria(
  prompt: string,
): Partial<RegionRecipe["requirements"]> {
  const result: Partial<RegionRecipe["requirements"]> = {};
  if (/雪原|雪地|snowfield|snowy/i.test(prompt)) result.minSnowCoverage = 0.65;
  if (/山地|山脉|mountain|起伏/i.test(prompt)) result.minRelief = 20;
  if (/火山|volcan/i.test(prompt)) {
    result.minCraterDepth = 8;
    result.minRelief = 25;
  }
  if (/城市|city|urban/i.test(prompt)) {
    result.minBuildings = 4;
    result.minRoadLength = 100;
  }
  if (/摩天|skyscraper/i.test(prompt)) {
    result.minBuildingHeight = 25;
    result.minTallBuildings = 2;
  }
  if (/汽车|车辆|cars|vehicles/i.test(prompt)) result.minVehicles = 2;
  if (/行驶|行进|driving|moving\s+(?:cars|vehicles)/i.test(prompt))
    result.minMovingVehicles = 2;
  return result;
}
function envelope(a: Asset) {
  const ps = a.design!.parts,
    size = (axis: number) =>
      Math.max(...ps.map((p) => p.position[axis] + p.size[axis] / 2)) -
      Math.min(...ps.map((p) => p.position[axis] - p.size[axis] / 2));
  return {
    halfX: (size(0) * a.scale) / 2,
    halfZ: (size(2) * a.scale) / 2,
    height: size(1) * a.scale,
  };
}
export function evaluateRegion(
  content: WorldContent,
  pack: ContentPackage,
  config: WorldConfig,
  prompt = "",
): RegionReport {
  const r = pack.region!,
    key = regionKey(pack),
    deployment = content.state.regionalDeployments.find(
      (d) => d.package === key,
    );
  const protectedKeys = new Set(deployment?.protectedChunks ?? []),
    chunks = new Map<string, ChunkData>(),
    assets = new Map<string, Asset>();
  const failures: string[] = [],
    heights: number[] = [];
  if (requestsWater(prompt) && !r.water)
    failures.push(
      msg(
        "world.region-validation.oceans-and-lakes-must-declare-region-water-and-generate",
      ),
    );
  if (r.water || requestsWater(prompt))
    for (const asset of waterTileAssets(pack))
      failures.push(
        msg(
          "world.region-validation.asset-simulates-a-separate-water-tile-ground-anchoring-creates",
          { p0: asset },
        ),
      );
  let white = 0,
    interior = 0;
  for (const cell of regionCells(r, config)) {
    if (protectedKeys.has(hexKey(cell))) continue;
    const chunk = content.generate(cell, config);
    chunks.set(chunk.key, chunk);
    const protectedCells = nearbyProtected(deployment, cell);
    for (let i = 0; i < chunk.positions.length; i += 3) {
      const x = chunk.center.x + chunk.positions[i],
        z = chunk.center.z + chunk.positions[i + 2];
      if (regionWeight(r, x, z, protectedCells, config) < 0.98) continue;
      heights.push(chunk.positions[i + 1]);
      interior++;
      if (Math.min(...chunk.colors.slice(i, i + 3)) > 0.6) white++;
    }
    for (const a of chunk.assets) if (a.contentKey === key) assets.set(a.id, a);
    if (![...chunk.positions].every(Number.isFinite))
      failures.push(
        msg("world.region-validation.chunk-contains-invalid-heights", {
          p0: chunk.key,
        }),
      );
  }
  const sample = (x: number, z: number) => {
    const c = chunks.get(hexKey(worldToHex(x, z, config.chunkRadius)));
    return c ? surfaceHeight(c, x, z) : undefined;
  };
  const buildings = [...assets.values()].filter((a) => a.role === "building"),
    roads = regionRoads(pack);
  let roadLength = 0;
  for (const road of roads) {
    let valid = true,
      length = 0;
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1],
        b = road.points[i],
        distance = Math.hypot(b.x - a.x, b.z - a.z);
      length += distance;
      if (distance < 0.5) valid = false;
      for (let j = 0; j <= Math.ceil(distance / 4); j++) {
        const t = j / Math.max(1, Math.ceil(distance / 4)),
          x = a.x + (b.x - a.x) * t,
          z = a.z + (b.z - a.z) * t;
        const height = sample(x, z),
          cell = worldToHex(x, z, config.chunkRadius);
        if (
          height === undefined ||
          regionWeight(r, x, z, nearbyProtected(deployment, cell), config) <
            0.98 ||
          Math.abs(height - (a.y + (b.y - a.y) * t)) > 0.5
        )
          valid = false;
      }
    }
    if (!valid)
      failures.push(
        msg(
          "world.region-validation.road-is-not-a-complete-level-road-in-the",
          { p0: road.id },
        ),
      );
    else roadLength += length;
  }
  for (const placement of r.placements)
    if (!assets.has(`${key}:object:${placement.id}`)) {
      const height = sample(
        r.center.x + placement.position.x,
        r.center.z + placement.position.z,
      );
      const design = pack.assets[placement.asset],
        top =
          Math.max(...design.parts.map((p) => p.position[1] + p.size[1] / 2)) *
          placement.scale;
      if (
        placement.habitat === "underwater" &&
        height !== undefined &&
        height + top >= config.terrain.waterLevel - 0.1
      )
        failures.push(
          msg(
            "world.region-validation.underwater-plant-has-water-depth-m-less-than-its",
            {
              p0: placement.id,
              p1: (config.terrain.waterLevel - height).toFixed(2),
              p2: top.toFixed(2),
            },
          ),
        );
      else if (
        placement.habitat === "land" &&
        height !== undefined &&
        height < config.terrain.waterLevel
      )
        failures.push(
          msg(
            "world.region-validation.land-object-is-underwater-move-it-ashore-or-correct",
            { p0: placement.id },
          ),
        );
      else
        failures.push(
          msg(
            "world.region-validation.object-was-not-generated-its-position-is-excluded-by",
            { p0: placement.id },
          ),
        );
    }
  // All independently placed geometry must have usable foundations and avoid other lots/roads.
  for (const a of buildings) {
    const box = envelope(a);
    if (!a.design!.collider && !a.design!.colliders?.length)
      failures.push(
        msg("world.region-validation.building-is-missing-a-collider", {
          p0: a.id,
        }),
      );
    const colliderTop = Math.max(
      0,
      ...[
        ...(a.design!.collider ? [a.design!.collider] : []),
        ...(a.design!.colliders ?? []),
      ].map((c) => (c.center[1] + c.halfExtents[1]) * a.scale),
    );
    if (colliderTop < box.height * 0.9)
      failures.push(
        msg(
          "world.region-validation.building-has-a-collider-that-does-not-cover-its",
          { p0: a.id },
        ),
      );
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const px = sx * box.halfX,
          pz = sz * box.halfZ;
        const h = sample(
          a.x + Math.cos(a.rotation) * px + Math.sin(a.rotation) * pz,
          a.z - Math.sin(a.rotation) * px + Math.cos(a.rotation) * pz,
        );
        if (h === undefined || Math.abs(h - a.y) > 0.65)
          failures.push(
            msg(
              "world.region-validation.building-has-an-uneven-foundation-level-the-region-or",
              { p0: a.id },
            ),
          );
      }
    for (const road of roads)
      if (
        road.points.some(
          (p, i) =>
            i &&
            segmentDistance(a, road.points[i - 1], p) <
              road.width / 2 + Math.hypot(box.halfX, box.halfZ),
        )
      )
        failures.push(
          msg("world.region-validation.building-occupies-road", {
            p0: a.id,
            p1: road.id,
          }),
        );
    for (const b of buildings)
      if (a.id < b.id) {
        const bb = envelope(b);
        if (
          Math.abs(a.x - b.x) < box.halfX + bb.halfX + 0.2 &&
          Math.abs(a.z - b.z) < box.halfZ + bb.halfZ + 0.2
        )
          failures.push(
            msg("world.region-validation.building-overlaps", {
              p0: a.id,
              p1: b.id,
            }),
          );
      }
  }
  let vehicles = 0,
    moving = 0;
  for (const v of r.vehicles) {
    if (
      !pack.assets[v.asset]?.collider &&
      !pack.assets[v.asset]?.colliders?.length
    )
      failures.push(
        msg("world.region-validation.vehicle-is-missing-a-collider", {
          p0: v.id,
        }),
      );
    let valid = true;
    const first = vehiclePose(pack, v, 0),
      second = vehiclePose(pack, v, 2);
    const road = roads.find((path) => path.id.endsWith(`:road:${v.road}`))!;
    const duration =
      road.points
        .slice(1)
        .reduce(
          (sum, p, i) =>
            sum + Math.hypot(p.x - road.points[i].x, p.z - road.points[i].z),
          0,
        ) / v.speed;
    for (let i = 0; i < 48; i++) {
      const pose = vehiclePose(pack, v, (duration * i) / 48),
        height = sample(pose.x, pose.z);
      const cell = worldToHex(pose.x, pose.z, config.chunkRadius);
      if (
        height === undefined ||
        Math.abs(height + 0.06 - pose.y) > 0.5 ||
        regionWeight(
          r,
          pose.x,
          pose.z,
          nearbyProtected(deployment, cell),
          config,
        ) < 0.98
      )
        valid = false;
    }
    if (!valid)
      failures.push(
        msg(
          "world.region-validation.vehicle-does-not-have-a-level-continuous-drivable-surface",
          { p0: v.id },
        ),
      );
    else {
      vehicles++;
      if (Math.hypot(second.x - first.x, second.z - first.z) > 0.5) moving++;
    }
  }
  let craterDepth = 0;
  for (const op of r.operators)
    if (op.kind === "volcano") {
      const x = r.center.x + op.offset.x,
        z = r.center.z + op.offset.z,
        center = sample(x, z);
      const rim = [0, 1, 2, 3].map((i) =>
        sample(
          x + Math.cos((i * Math.PI) / 2) * op.craterRadius,
          z + Math.sin((i * Math.PI) / 2) * op.craterRadius,
        ),
      );
      if (center !== undefined && rim.every((v) => v !== undefined))
        craterDepth = Math.max(
          craterDepth,
          Math.min(...(rim as number[])) - center,
        );
    }
  if (
    r.operators.some((op) => op.kind === "volcano") &&
    craterDepth <
      Math.max(
        r.requirements.minCraterDepth,
        requestedCriteria(prompt).minCraterDepth ?? 0,
      ) &&
    r.preserveCorridors
  )
    failures.unshift(
      msg(
        "world.region-validation.the-crater-was-flattened-by-existing-road-river-protection",
      ),
    );
  const tallHeight = Math.max(
    r.requirements.minBuildingHeight,
    requestedCriteria(prompt).minBuildingHeight ?? 0,
  );
  const measured = {
    minRelief: heights.length
      ? heights.reduce((a, b) => Math.max(a, b), -Infinity) -
        heights.reduce((a, b) => Math.min(a, b), Infinity)
      : 0,
    minSnowCoverage: interior ? white / interior : 0,
    minCraterDepth: craterDepth,
    minBuildings: buildings.length,
    minBuildingHeight: buildings.length
      ? Math.max(...buildings.map((a) => envelope(a).height))
      : 0,
    minTallBuildings: buildings.filter((a) => envelope(a).height >= tallHeight)
      .length,
    minRoadLength: roadLength,
    minVehicles: vehicles,
    minMovingVehicles: moving,
  };
  const required = { ...r.requirements };
  for (const [criterion, value] of Object.entries(requestedCriteria(prompt)))
    required[criterion as keyof typeof required] = Math.max(
      required[criterion as keyof typeof required] ?? 0,
      value,
    );
  const metrics = Object.entries(required)
    .filter(([, v]) => v > 0)
    .map(([criterion, value]) => ({
      criterion,
      actual:
        Math.round(measured[criterion as keyof typeof measured] * 100) / 100,
      required: value,
      passed: measured[criterion as keyof typeof measured] + 1e-4 >= value,
    }));
  const water = r.water
    ? measureRegionWater(
        pack,
        chunks.values(),
        assets.values(),
        config,
        deployment,
      )
    : undefined;
  if (water) {
    const expected = [
      {
        criterion: "minWaterArea",
        actual: water.area,
        required:
          r.water!.kind === "ocean"
            ? Math.max(1500, Math.PI * (r.radius - r.transition) ** 2 * 0.2)
            : 200,
      },
      {
        criterion: "minWaterDepth",
        actual: water.maxDepth,
        required: r.water!.kind === "ocean" ? 3 : 1,
      },
      { criterion: "minShoreline", actual: water.shoreline, required: 40 },
      { criterion: "minBeachArea", actual: water.beachArea, required: 40 },
      {
        criterion: "minConnectedWaterRatio",
        actual: water.largestComponentRatio,
        required: 0.85,
      },
    ];
    if (/海带|水草|kelp|seaweed|seagrass/i.test(prompt))
      expected.push({
        criterion: "minSubmergedPlants",
        actual: water.submergedPlants,
        required: 8,
      });
    for (const m of expected)
      metrics.push({
        ...m,
        actual: Math.round(m.actual * 100) / 100,
        passed: m.actual + 1e-4 >= m.required,
      });
  }
  for (const metric of metrics)
    if (!metric.passed)
      failures.push(
        msg("world.region-validation.actual-required-at-least", {
          p0: metric.criterion,
          p1: metric.actual,
          p2: metric.required,
        }),
      );
  if (!interior)
    failures.push(
      msg(
        "world.region-validation.there-is-no-generatable-new-region-interior-an-empty",
      ),
    );
  const uniqueFailures = [...new Set(failures)];
  const unsupported = [...r.unsupported];
  if (
    water &&
    /飘荡|摇曳|摆动|sway(?:ing)?|drift(?:ing)?/i.test(prompt) &&
    /海带|水草|kelp|seaweed|seagrass/i.test(prompt) &&
    !unsupported.some((s) => /摆动|飘荡|摇曳|sway|drift/i.test(s))
  )
    unsupported.push(
      msg(
        "world.region-validation.underwater-plants-were-generated-but-kelp-and-seagrass-swaying",
      ),
    );
  const status = uniqueFailures.length
    ? "failed"
    : unsupported.length
      ? "partial"
      : "passed";
  return {
    status,
    package: key,
    chunks: chunks.size,
    metrics,
    failures: uniqueFailures,
    unsupported,
    ...(water ? { water } : {}),
    summary: water
      ? msg(
          "world.region-validation.recomputed-chunks-shared-sea-level-m-native-water-area",
          {
            p0: chunks.size,
            p1: water.level.toFixed(2),
            p2: Math.round(water.area),
            p3: water.maxDepth.toFixed(1),
            p4: Math.round(water.shoreline),
            p5: water.submergedPlants,
          },
        )
      : msg(
          "world.region-validation.recomputed-new-chunks-buildings-m-of-roads-vehicles-drivable",
          {
            p0: chunks.size,
            p1: buildings.length,
            p2: Math.round(roadLength),
            p3: vehicles,
            p4: moving,
            p5: measured.minRelief.toFixed(1),
            p6: craterDepth.toFixed(1),
          },
        ),
  };
}

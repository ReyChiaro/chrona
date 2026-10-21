/** Real API -> native browser world -> physics -> persistence. Never edits existing user worlds. */
import { chromium } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../packages/protocol/src/config";
import { spawnPosition } from "../packages/world/src/terrain";
import { suggestRegionSite, regionCells } from "../packages/world/src/regions";
import { hexCenter } from "../packages/world/src/hex";
import type { WorldSnapshot } from "../packages/protocol/src/contracts";

if (!process.argv.includes("--api"))
  throw new Error(
    "Explicit --api required; unconfigured models never fall back to demos",
  );
const base = process.env.WEB_BASE_URL ?? "http://127.0.0.1:4173";
const output = resolve(
  process.env.VALIDATION_DIR ?? ".data/validation/regions",
);
await mkdir(output, { recursive: true });
const headers: Record<string, string> = {
  "Content-Type": "application/json",
  Connection: "close",
};
if (process.env.AGENT_ACCESS_TOKEN)
  headers.Authorization = `Bearer ${process.env.AGENT_ACCESS_TOKEN}`;
async function request(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<any> {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error) => {
    throw new Error(`${method} ${path}: ${error.cause?.code ?? error.message}`);
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
const status = await request("/api/content/agent/status");
if (status.mode !== "api") throw new Error("Actual API mode required");
const cases = [
  {
    name: "snow",
    label: "Snowy mountains",
    prompt:
      "Add rolling snowfields and mountains in unexplored regions. Preserve road and river passages and all explored regions.",
  },
  {
    name: "volcano",
    label: "Volcano",
    prompt: "Add volcanic terrain with suitable new materials and objects.",
  },
  {
    name: "city",
    label: "City",
    prompt:
      "Create a city ahead with multiple skyscrapers, roads and moving cars.",
  },
];
const only = process.argv
  .find((a) => a.startsWith("--only="))
  ?.slice("--only=".length);
if (only && !cases.some((c) => c.name === only))
  throw new Error("Unknown acceptance case");
const replayPath = process.argv
  .find((a) => a.startsWith("--replay="))
  ?.slice("--replay=".length);
const replay = replayPath
  ? JSON.parse(await readFile(replayPath, "utf8"))
  : undefined;
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : { channel: "chromium" },
);
const reports: any[] = [];
try {
  for (const item of cases.filter((c) => !only || c.name === only)) {
    const config = structuredClone(replay?.request.config ?? DEFAULT_CONFIG);
    config.seed = "regional-acceptance";
    config.clock.timeScale = 1;
    config.loadRange = 4;
    const worldId = replay?.request.worldId ?? crypto.randomUUID(),
      requestId = replay?.request.requestId ?? crypto.randomUUID();
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      if (replay) {
        const existing = await request(`/api/worlds/${worldId}`);
        if (
          !existing.name.startsWith("Regional validation") &&
          !existing.name.startsWith("区域验收")
        )
          throw new Error(
            "Replay only resets this script’s isolated acceptance worlds",
          );
      }
      // No Node-generated fingerprints are transferred: browsers own world generation and saves.
      const initial = {
        formatVersion: 1,
        generatorVersion: (await request("/api/health")).generatorVersion,
        id: worldId,
        name: `Regional validation · ${item.label}`,
        config,
        tick: 0,
        elapsedSeconds: 0,
        camera: replay?.request.camera ?? spawnPosition(config),
        chunks: [],
        trail: [],
        savedAt: new Date().toISOString(),
      };
      await request(`/api/worlds/${worldId}`, initial, "PUT");
      await page.goto(`${base}/?world=${worldId}`);
      await page.waitForFunction(() => window.chrona?.ready, null, {
        timeout: 60000,
      });
      const before = await page.evaluate(async () => {
        await window.chrona.runtime.pause(true);
        await window.chrona.save();
        return window.chrona.snapshot();
      });
      const site = suggestRegionSite(config, before.camera, before.chunks);
      console.log(
        JSON.stringify({
          case: item.name,
          phase: replay
            ? "replaying-recorded-real-agent-in-browser"
            : "calling-real-agent",
          requestId,
          site,
        }),
      );
      const captured = await page.evaluate(async () => ({
        camera: { ...window.chrona.runtime.camera },
        context: window.chrona.content.inspect(),
      }));
      const reply =
        replay ??
        (await request("/api/content/edit", {
          requestId,
          worldId,
          prompt: item.prompt,
          selection: {
            kind: "ground",
            label: "Region generation direction",
            point: {
              x: before.camera.x,
              y: before.camera.y - config.physics.eyeHeight,
              z: before.camera.z,
            },
          },
          camera: captured.camera,
          referenceIds: [],
          history: [],
          config,
          target: null,
          context: {
            ...captured.context,
            authoring: {
              site,
              protectedChunks: before.chunks.map((c) => `${c.q},${c.r}`),
            },
          },
        }));
      assert.equal(reply.mode, "api");
      assert.equal(reply.release?.package.protocol, 2);
      assert.equal(reply.plan?.action, "future");
      await writeFile(
        resolve(output, `${item.name}-response.json`),
        JSON.stringify(reply, null, 2),
      );
      const applied = await page.evaluate(
        async (reply) =>
          window.chrona.editor.apply(reply.plan, reply.release.package),
        reply,
      );
      const actual = applied.regionReport!;
      assert.ok(actual && actual.status !== "failed", JSON.stringify(actual));
      assert.deepEqual(
        await page.evaluate(async () => window.chrona.snapshot().chunks),
        before.chunks,
      );
      const centers = regionCells(reply.release.package.region, config).map(
        (cell) => hexCenter(cell, config.chunkRadius),
      );
      const observed = await page.evaluate(
        async ({ centers, center, packageKey }) => {
          const r = window.chrona.runtime,
            buildings = new Set<string>(),
            objects = new Set<string>();
          for (const p of centers) {
            await r.teleport(p.x, p.z);
            for (const a of r.chunks.assets.values())
              if (a.contentKey === packageKey) {
                objects.add(a.id);
                if (a.role === "building") buildings.add(a.id);
              }
          }
          await r.teleport(center.x, center.z);
          return { buildings: buildings.size, objects: objects.size };
        },
        {
          centers,
          center: reply.release.package.region.center,
          packageKey: `${reply.release.package.id}@${reply.release.package.version}`,
        },
      );
      let motion;
      if (item.name === "city") {
        motion = await page.evaluate(async () => {
          const r = window.chrona.runtime,
            before = new Map(
              [...r.traffic.assets].map(([id, a]) => [id, { x: a.x, z: a.z }]),
            );
          await r.pause(false);
          for (let i = 0; i < 180; i++)
            r.update(1 / 60, {
              forward: 0,
              right: 0,
              sprint: false,
              jump: false,
            });
          await r.pause(true);
          const moved = [...r.traffic.assets].filter(
            ([id, a]) =>
              before.has(id) &&
              Math.hypot(a.x - before.get(id)!.x, a.z - before.get(id)!.z) > 1,
          ).length;
          const frozen = JSON.stringify([...r.traffic.assets]);
          r.update(1, { forward: 0, right: 0, sprint: false, jump: false });
          return {
            movingCars: moved,
            activeVehicleBodies: r.traffic.bodies.size,
            pausedStable: frozen === JSON.stringify([...r.traffic.assets]),
          };
        });
        assert.ok(motion.movingCars >= 2 && motion.pausedStable);
        assert.equal(
          observed.buildings,
          actual.metrics.find((m) => m.criterion === "minBuildings")!.actual,
        );
      }
      await page.evaluate(async (before) => {
        const r = window.chrona.runtime;
        await r.teleport(before.camera.x, before.camera.z, before.camera.y);
      }, before);
      let after = await page.evaluate(async () => window.chrona.snapshot());
      for (const c of before.chunks)
        assert.equal(
          after.chunks.find((p) => p.q === c.q && p.r === c.r)!.fingerprint,
          c.fingerprint,
        );
      await page.evaluate(async (center) => {
        const r = window.chrona.runtime;
        await r.teleport(center.x, center.z);
        await r.pause(true);
        return window.chrona.save();
      }, reply.release.package.region.center);
      after = await page.evaluate(async () => window.chrona.snapshot());
      await page.reload();
      await page.waitForFunction(() => window.chrona?.ready, null, {
        timeout: 60000,
      });
      const restored = await page.evaluate(async () =>
        window.chrona.snapshot(),
      );
      assert.equal(restored.content!.regionalDeployments.length, 1);
      for (const c of after.chunks)
        assert.equal(
          restored.chunks.find((p) => p.q === c.q && p.r === c.r)!.fingerprint,
          c.fingerprint,
        );
      await page.evaluate(async (city) => {
        await window.chrona.runtime.pause(!city);
        return window.chrona.save();
      }, item.name === "city");
      const snapshot = await page.evaluate(async () =>
        window.chrona.snapshot(),
      );
      assert.deepEqual(errors, []);
      await request(`/api/content/edits/${requestId}/receipt`, {
        worldId,
        status: actual.status === "partial" ? "partial" : "applied",
        revision: snapshot.content!.revision,
        regionReport: actual,
      });
      const report = {
        case: item.name,
        status: actual.status,
        prompt: item.prompt,
        requestId,
        worldId,
        package: reply.release.package.id,
        model: reply.model,
        actual,
        observed,
        motion,
        nativeBrowser: true,
        oldChunksUnchanged: before.chunks.length,
        persistedChunks: snapshot.chunks.length,
        restored: true,
        url: `${base}/?world=${worldId}`,
      };
      await writeFile(
        resolve(output, `${item.name}.json`),
        JSON.stringify(
          {
            ...report,
            plan: reply.plan,
            source: reply.release.source,
            trace: reply.trace,
          },
          null,
          2,
        ),
      );
      await writeFile(
        resolve(output, `${item.name}-world.json`),
        JSON.stringify(snapshot),
      );
      reports.push(report);
      console.log(JSON.stringify(report));
    } catch (error) {
      const failure = {
        case: item.name,
        requestId,
        worldId,
        status: "failed",
        error: (error as Error).message,
        browserErrors: errors,
      };
      try {
        await page.screenshot({
          path: resolve(output, `${item.name}-failure.png`),
        });
        failure.error +=
          " " +
          (await page
            .locator("#loading-message")
            .innerText({ timeout: 1000 })
            .catch(() => ""));
      } catch {}
      reports.push(failure);
      console.log(JSON.stringify(failure));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
let previous: any[] = [];
try {
  previous = JSON.parse(await readFile(resolve(output, "report.json"), "utf8"));
} catch {}
const combined = new Map([...previous, ...reports].map((r) => [r.case, r]));
await writeFile(
  resolve(output, "report.json"),
  JSON.stringify([...combined.values()], null, 2),
);
if (reports.some((r) => r.status === "failed")) process.exitCode = 1;

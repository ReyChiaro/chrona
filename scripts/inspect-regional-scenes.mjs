/** Inspect already generated acceptance worlds in the real web UI; does not call a model. */
import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";
const base = process.env.WEB_BASE_URL ?? "http://127.0.0.1:4173";
const output = resolve(
  process.env.VALIDATION_DIR ?? ".data/validation/regions",
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? {
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        headless: true,
      }
    : { channel: "chromium" },
);
try {
  const inspections = [];
  for (const name of ["snow", "volcano", "city"]) {
    const report = JSON.parse(
      await readFile(resolve(output, `${name}.json`), "utf8"),
    );
    const context = await browser.newContext({
        viewport: { width: 1600, height: 1000 },
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/?world=${report.worldId}`);
    await page.waitForFunction(() => window.chrona?.ready, null, {
      timeout: 45000,
    });
    const original = await page.evaluate(async () => ({
      camera: { ...window.chrona.runtime.camera },
      paused: window.chrona.runtime.clock.paused,
      presentation: { ...window.chrona.runtime.config.presentation },
    }));
    await page.evaluate(async (name) => {
      const r = window.chrona.runtime;
      if (
        !r.name.startsWith("Regional validation") &&
        !r.name.startsWith("区域验收")
      )
        throw new Error("Only inspect isolated acceptance worlds");
      await r.pause(true);
      await r.applyRuntimeConfig({
        ...r.config,
        presentation: {
          ...r.config.presentation,
          showGlobalTrail: false,
          showMapTrail: false,
        },
      });
      const pack = r.content.state.packages.find((p) => p.region),
        region = pack.region;
      let x = region.center.x + 50,
        z = region.center.z + 60,
        targetX = region.center.x,
        targetZ = region.center.z;
      const volcano = region.operators.find((op) => op.kind === "volcano");
      if (volcano) {
        targetX += volcano.offset.x;
        targetZ += volcano.offset.z;
        x = targetX + volcano.craterRadius + 12;
        z = targetZ + 6;
      }
      if (name === "city") {
        const car = [...r.traffic.assets.values()][0];
        if (!car) throw new Error("No runtime vehicles in city");
        x = car.x + Math.sin(car.rotation) * 11;
        z = car.z + Math.cos(car.rotation) * 11;
        targetX = car.x;
        targetZ = car.z;
      }
      if (name !== "city") {
        x = region.center.x + region.radius * 0.75;
        z = region.center.z + region.radius * 0.75;
      }
      const peak = Math.max(
        ...[...r.chunks.active.values()].flatMap((c) =>
          Array.from(c.positions).filter((_, i) => i % 3 === 1),
        ),
      );
      await r.teleport(
        x,
        z,
        name === "city" ? undefined : peak + region.radius * 0.55,
      );
      await r.setCameraPose({ yaw: Math.atan2(x - targetX, z - targetZ) });
      const targetY =
        name === "city"
          ? r.groundHeight(targetX, targetZ) + 1
          : r.groundHeight(targetX, targetZ) + 3;
      await r.setCameraPose({
        pitch: Math.max(
          -1.2,
          Math.min(
            0.8,
            Math.atan2(
              targetY - r.camera.y,
              Math.hypot(x - targetX, z - targetZ),
            ),
          ),
        ),
      });
    }, name);
    await page.waitForTimeout(1600);
    const result = await page.evaluate(async () => ({
      chunks: window.chrona.runtime.chunks.active.size,
      independentBuildings: [
        ...window.chrona.runtime.chunks.assets.values(),
      ].filter((a) => a.role === "building").length,
      cars: [...window.chrona.runtime.traffic.assets].map(([id, a]) => ({
        id,
        x: a.x,
        z: a.z,
      })),
      context: window.chrona.content.inspect(),
      overview: window.chrona.overview(),
    }));
    if (name === "city") {
      assert.ok(result.cars.length >= 2);
      await page.evaluate(async () => await window.chrona.runtime.pause(false));
      await page.waitForTimeout(2200);
      const moved = await page.evaluate(
        async (before) =>
          before.filter((a) => {
            const now = window.chrona.runtime.traffic.assets.get(a.id);
            return now && Math.hypot(now.x - a.x, now.z - a.z) > 1;
          }).length,
        result.cars,
      );
      assert.ok(
        moved >= 2,
        "Cars must move in the real browser animation loop",
      );
      result.browserMovingCars = moved;
      await page.evaluate(async () => {
        const r = window.chrona.runtime;
        await r.pause(true);
        const car = [...r.traffic.assets.values()][0];
        await r.teleport(
          car.x + Math.sin(car.rotation) * 6,
          car.z + Math.cos(car.rotation) * 6,
        );
        await r.setCameraPose({ yaw: car.rotation });
        await r.setCameraPose({ pitch: -0.04 });
      });
      await page.waitForTimeout(150);
    }
    await page
      .locator("#first-canvas")
      .screenshot({ path: resolve(output, `${name}-proxy.png`) });
    await page.screenshot({
      path: resolve(output, `${name}-workspace.png`),
      fullPage: false,
    });
    assert.deepEqual(errors, []);
    assert.equal(result.overview.workerError, "");
    inspections.push({
      case: name,
      worldId: report.worldId,
      ...result,
      errors,
    });
    await page.evaluate(async (original) => {
      const r = window.chrona.runtime;
      await r.teleport(original.camera.x, original.camera.z, original.camera.y);
      await r.setCameraPose(original.camera);
      await r.pause(original.paused);
      await r.applyRuntimeConfig({
        ...r.config,
        presentation: original.presentation,
      });
      await window.chrona.save();
    }, original);
    await context.close();
    console.log(
      JSON.stringify({
        case: name,
        inspected: true,
        browserMovingCars: result.browserMovingCars ?? 0,
      }),
    );
  }
  await writeFile(
    resolve(output, "browser-inspection.json"),
    JSON.stringify(inspections, null, 2),
  );
} finally {
  await browser.close();
}

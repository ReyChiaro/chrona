/** Record the real proxy viewer without requiring an inference service. */
import { chromium } from "@playwright/test";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const base = process.env.WEB_BASE_URL;
if (!base) throw new Error("WEB_BASE_URL is required");
const output = resolve(
  process.env.PROXY_OUTPUT ?? ".data/validation/proxy.webm",
);
const seconds = Number(process.env.PROXY_SECONDS);
if (!(seconds > 0)) throw new Error("PROXY_SECONDS must be positive");
const profile = JSON.parse(
  await readFile(
    process.env.RENDER_PROFILE ?? "configs/render-profile.json",
    "utf8",
  ),
);
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : { channel: "chromium" },
);
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/render/capabilities", (route) =>
    route.fulfill({
      json: {
        ...profile,
        enabled: true,
        providerState: "ready",
        prompt: "",
        systemPrompt: "",
        conditions: {},
        fps: profile.reference.fps,
      },
    }),
  );
  await page.route("**/api/render/jobs", (route) =>
    route.fulfill({ json: { jobs: [] } }),
  );
  await page.goto(base);
  await page.waitForFunction(() => window.chrona?.ready);
  await page.waitForFunction(
    () => !document.querySelector("#record-toggle").disabled,
  );
  await page.locator("#record-toggle").click();
  await page.keyboard.down("w");
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up("w");
  await page.keyboard.press("r");
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => !document.querySelector("#take-actions").hidden,
  );
  const encoded = await page.evaluate(async () => {
    const blob = await (
      await fetch(document.querySelector("#download-source").href)
    ).blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.readAsDataURL(blob);
    });
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, Buffer.from(encoded, "base64"));
  await page.screenshot({
    path: output.replace(/\.[^.]+$/, ".png"),
    fullPage: true,
  });
  await writeFile(
    output.replace(/\.[^.]+$/, ".world.json"),
    JSON.stringify(
      await page.evaluate(() => window.chrona.snapshot()),
      null,
      2,
    ),
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(JSON.stringify({ output, seconds, errors }));
} finally {
  await browser.close();
}

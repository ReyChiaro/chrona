import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

const url = process.env.BASE_URL ?? "http://127.0.0.1:4173";
const browser = await chromium.launch({ channel: "chromium", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(url);
  await page.waitForFunction(() => window.chrona?.ready);
  await page.waitForFunction(
    () => !document.querySelector("#record-toggle").disabled,
  );
  await page.locator("#record-toggle").click();
  await page.keyboard.down("w");
  await page.waitForFunction(
    () => !document.querySelector("#take-actions").hidden,
    { timeout: 30000 },
  );
  await page.keyboard.up("w");
  await page.locator("#video-settings-toggle").click();
  if (process.env.SMOKE_STEPS)
    await page
      .locator("#render-parameters [name=steps]")
      .fill(process.env.SMOKE_STEPS);
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/render/jobs") &&
      response.request().method() === "POST",
  );
  await page.locator("#submit-render").click();
  const response = await submitted;
  const job = await response.json();
  if (!response.ok()) throw new Error(JSON.stringify(job));
  await mkdir(".data/validation", { recursive: true });
  await writeFile(
    ".data/validation/smoke-job.json",
    JSON.stringify({ job, errors }, null, 2),
  );
  await page.screenshot({ path: ".data/validation/world.png", fullPage: true });
  console.log(
    JSON.stringify({ submitted: job.id, status: job.status, errors }),
  );
} finally {
  await browser.close();
}

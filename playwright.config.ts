import { defineConfig } from "@playwright/test";
const port = Number(process.env.TEST_PORT ?? 4174);
const renderPort = Number(process.env.TEST_RENDER_PORT ?? port + 100);
const dataRoot = process.env.TEST_DATA_ROOT ?? ".data/browser-tests";
const renderUrl = `http://127.0.0.1:${renderPort}`;
export default defineConfig({
  testDir: "./tests/browser",
  testIgnore: "**/._*",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  outputDir: process.env.TEST_OUTPUT_DIR ?? "test-results",
  expect: { timeout: 10000 },
  reporter: "list",
  use: {
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://127.0.0.1:${port}`,
          localStorage: [{ name: "chrona:locale", value: "zh-Hans" }],
        },
      ],
    },
    channel: "chromium",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `uv run --frozen --no-sync uvicorn chrona.api.app:create_app --factory --host 127.0.0.1 --port ${renderPort}`,
      url: `${renderUrl}/api/render/health`,
      reuseExistingServer: false,
      env: {
        CHRONA_DATA_DIR: `${dataRoot}/render`,
        CHRONA_PROVIDER: "chrona.adapters.providers.disabled:DisabledRenderer",
        CHRONA_PRELOAD: "false",
        CHRONA_AGENT_ENABLED: "false",
        CHRONA_AGENT_WORLD_URL: `http://127.0.0.1:${port}`,
        CHRONA_AGENT_BROWSER_ORIGIN: `http://127.0.0.1:${port}`,
      },
    },
    {
      command: "npm run start",
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(port),
        WORLD_DATA_DIR: `${dataRoot}/worlds`,
        CONTENT_DATA_DIR: `${dataRoot}/content`,
        RENDER_SERVICE_URL: renderUrl,
        AUTHORING_SERVICE_URL: renderUrl,
      },
    },
  ],
});

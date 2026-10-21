import { withRequestLocale } from "./locale";
import { msg } from "../../../packages/i18n/src/index";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  configSchema,
  GENERATOR_VERSION,
} from "../../../packages/protocol/src/config";
import { WorldStore } from "../../../packages/adapters/src/storage/world-store";
import { proxyRender } from "./render-proxy";
import { HttpError, json } from "./http";
import { worldRoutes } from "./world-routes";
import { ContentRegistry, contentRoutes } from "./content-registry";
import { agentRoutes } from "./agent-routes";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const BODY_LIMIT = Number(process.env.REQUEST_BODY_LIMIT ?? 12 * 1024 * 1024);

export async function startServer(
  options: {
    port?: number;
    host?: string;
    dataDirectory?: string;
    production?: boolean;
    frontend?: boolean;
  } = {},
) {
  const production =
    options.production ?? process.argv.includes("--production");
  const store = new WorldStore(
    options.dataDirectory ??
      resolve(
        root,
        process.env.WORLD_DATA_DIR ??
          resolve(root, process.env.CHRONA_DATA_DIR ?? ".data", "worlds"),
      ),
  );
  const contentRegistry = new ContentRegistry(
    resolve(
      root,
      process.env.CONTENT_DATA_DIR ??
        resolve(root, process.env.CHRONA_DATA_DIR ?? ".data", "content"),
    ),
  );
  const config = configSchema.parse(
    process.env.WORLD_CONFIG
      ? JSON.parse(
          await readFile(resolve(root, process.env.WORLD_CONFIG), "utf8"),
        )
      : {},
  );
  const vite =
    options.frontend === false || production
      ? null
      : await (
          await import("vite")
        ).createServer({
          root,
          server: { middlewareMode: true },
          appType: "spa",
        });
  const server = createServer((request, response) =>
    withRequestLocale(request.headers["accept-language"], async () => {
      try {
        const url = new URL(
          request.url ?? "/",
          `http://${request.headers.host ?? "localhost"}`,
        );
        const path = url.pathname;
        if (path.startsWith("/api/render/"))
          return proxyRender(
            request,
            response,
            process.env.RENDER_SERVICE_URL ?? "http://127.0.0.1:8090",
          );
        if (path === "/api/health")
          return json(response, 200, {
            status: "ok",
            generatorVersion: GENERATOR_VERSION,
          });
        if (path === "/api/config")
          return json(response, 200, {
            config,
            generatorVersion: GENERATOR_VERSION,
          });
        if (path === "/api/capabilities")
          return json(response, 200, {
            contractsVersion: 1,
            world: { hexagonal: true, persistence: true, fixedClock: true },
            video: {
              mode: "automatic-segments",
              capabilitiesUrl: "/api/render/capabilities",
              jobsUrl: "/api/render/jobs",
            },
            content: {
              connected: true,
              protocolUrl: "/api/content/protocol",
              agentUrl: "/api/content/agent/status",
              mode: "configurable-agent-and-data-plugins",
            },
          });
        if (await worldRoutes(request, response, path, store, BODY_LIMIT))
          return;
        if (
          await agentRoutes(
            request,
            response,
            path,
            process.env.AUTHORING_SERVICE_URL ||
              process.env.RENDER_SERVICE_URL ||
              "http://127.0.0.1:8090",
          )
        )
          return;
        if (
          await contentRoutes(
            request,
            response,
            path,
            contentRegistry,
            process.env.AUTHORING_SERVICE_URL ||
              process.env.RENDER_SERVICE_URL ||
              "http://127.0.0.1:8090",
          )
        )
          return;
        if (path.startsWith("/api/integrations/"))
          return json(response, 501, {
            error: msg(
              "api.index.no-matching-content-or-video-service-is-registered",
            ),
            code: "PROVIDER_NOT_CONNECTED",
          });
        if (path.startsWith("/api/"))
          return json(response, 404, {
            error: msg("api.index.api-endpoint-not-found"),
          });
        if (vite)
          return vite.middlewares(request, response, () => {
            response.writeHead(404);
            response.end();
          });
        if (options.frontend === false) throw new HttpError(404, "Not found");
        const dist = resolve(root, "dist");
        let filename = resolve(dist, `.${decodeURIComponent(path)}`);
        if (filename !== dist && !filename.startsWith(dist + sep))
          throw new HttpError(400, "Invalid path");
        if (path.endsWith("/")) filename = resolve(filename, "index.html");
        if (!(await stat(filename).catch(() => null))?.isFile())
          filename = resolve(dist, "index.html");
        const content = await readFile(filename);
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".wasm": "application/wasm",
          ".json": "application/json; charset=utf-8",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".mp4": "video/mp4",
          ".ttf": "font/ttf",
        };
        response.writeHead(200, {
          "Content-Type": mime[extname(filename)] ?? "application/octet-stream",
        });
        response.end(content);
      } catch (error) {
        if (response.headersSent) {
          response.end();
          return;
        }
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) console.error(error);
        json(response, status, {
          error:
            error instanceof HttpError
              ? error.message
              : msg(
                  "api.index.the-service-cannot-complete-this-request-right-now",
                ),
        });
      }
    }),
  );
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(
      options.port ?? Number(process.env.PORT ?? 4173),
      options.host ?? process.env.HOST ?? "127.0.0.1",
      accept,
    );
  });
  return {
    server,
    store,
    close: async () => {
      await vite?.close();
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = await startServer();
  const address = app.server.address();
  if (address && typeof address !== "string")
    console.log(`Chrona → http://${address.address}:${address.port}`);
  const shutdown = () => {
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

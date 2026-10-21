import { msg } from "../../../packages/i18n/src/index";
import { CheckpointConflict } from "../../../packages/adapters/src/storage/world-store";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GENERATOR_VERSION } from "../../../packages/protocol/src/config";
import { snapshotSchema } from "../../../packages/protocol/src/contracts";
import type { WorldSessionStorePort as WorldStore } from "../../../packages/world/src/ports/storage";
import { HttpError, json, readJson } from "./http";

export async function worldRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  store: WorldStore,
  limit: number,
): Promise<boolean> {
  if (path === "/api/worlds" && request.method === "GET") {
    json(response, 200, { worlds: await store.list() });
    return true;
  }
  const claim = /^\/api\/worlds\/([a-zA-Z0-9_-]{1,80})\/session$/.exec(path);
  if (claim && request.method === "POST") {
    if (
      request.headers["sec-fetch-site"] === "cross-site" ||
      (request.headers.origin &&
        new URL(request.headers.origin).host !== request.headers.host)
    )
      throw new HttpError(
        403,
        msg("api.world-routes.open-a-world-session-from-this-workspace"),
      );
    request.resume();
    json(response, 200, await store.claim(claim[1]));
    return true;
  }
  const match = /^\/api\/worlds\/([a-zA-Z0-9_-]{1,80})$/.exec(path);
  if (!match) return false;
  if (request.method === "GET") {
    try {
      json(response, 200, await store.read(match[1]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new HttpError(404, msg("api.world-routes.world-save-not-found"));
      throw error;
    }
    return true;
  }
  if (request.method === "PUT" || request.method === "POST") {
    const result = snapshotSchema.safeParse(await readJson(request, limit));
    if (!result.success)
      throw new HttpError(
        400,
        msg("api.world-routes.invalid-save-format", {
          p0: result.error.issues[0]?.message,
        }),
      );
    if (!result.data.execution)
      throw new HttpError(
        400,
        msg("adapters.runtime.a-complete-physics-checkpoint-is-required"),
      );
    if (result.data.id !== match[1])
      throw new HttpError(
        400,
        msg("api.world-routes.the-save-id-does-not-match"),
      );
    if (result.data.generatorVersion !== GENERATOR_VERSION)
      throw new HttpError(
        409,
        msg("api.world-routes.the-generator-version-is-incompatible"),
      );
    let saved;
    try {
      saved = await store.write(
        result.data,
        typeof request.headers["x-chrona-session"] === "string"
          ? request.headers["x-chrona-session"]
          : undefined,
      );
    } catch (error) {
      if (error instanceof CheckpointConflict)
        throw new HttpError(409, error.message);
      throw error;
    }
    json(response, 200, { id: saved.id, savedAt: saved.savedAt });
    return true;
  }
  return false;
}

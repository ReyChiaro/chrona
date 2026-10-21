import { msg } from "../../../packages/i18n/src/index";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  contentPackageSchema,
  packageKey,
  editPlanSchema,
  selectionSchema,
  storedObjectSchema,
  type ContentPackage,
} from "../../../packages/protocol/src/content";
import { dynamicEntitySchema } from "../../../packages/protocol/src/physics-contracts";
import { configSchema } from "../../../packages/protocol/src/config";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, json, readJson } from "./http";

import {
  compilePlugin,
  validatePackage,
} from "../../../packages/proxy/src/compiler";
export {
  compilePlugin,
  validatePackage,
} from "../../../packages/proxy/src/compiler";

export class ContentRegistry {
  constructor(readonly root: string) {}
  async stage(
    source: string,
    config?: unknown,
    trace: unknown = [],
    context: { protectedChunks?: string[]; prompt?: string } = {},
  ) {
    const pack = compilePlugin(source);
    let report;
    try {
      report = validatePackage(pack, config, context);
    } catch (error) {
      const directory = resolve(this.root, "rejected");
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, `${randomUUID()}.json`),
        JSON.stringify(
          {
            source,
            package: pack,
            error: (error as Error).message,
            createdAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      throw error;
    }
    const id = randomUUID(),
      digest = createHash("sha256").update(JSON.stringify(pack)).digest("hex");
    const configurationHash = createHash("sha256")
      .update(JSON.stringify(configSchema.parse(config ?? {})))
      .digest("hex");
    const value = {
      id,
      package: pack,
      source,
      report,
      digest,
      configurationHash,
      trace: [
        ...(Array.isArray(trace) ? trace : []),
        { tool: "compile_validate_stage", digest, report },
      ],
      published: false,
      createdAt: new Date().toISOString(),
    };
    await mkdir(resolve(this.root, "drafts"), { recursive: true });
    await writeFile(
      resolve(this.root, "drafts", `${id}.json`),
      JSON.stringify(value, null, 2),
    );
    return value;
  }
  async publish(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new HttpError(400, msg("api.content-registry.invalid-draft-id"));
    const value = JSON.parse(
      await readFile(resolve(this.root, "drafts", `${id}.json`), "utf8"),
    );
    const dir = resolve(this.root, "packages", packageKey(value.package));
    await mkdir(dir, { recursive: true });
    const output = { ...value, published: true };
    try {
      await writeFile(
        resolve(dir, "release.json"),
        JSON.stringify(output, null, 2),
        { flag: "wx" },
      );
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      const old = JSON.parse(
        await readFile(resolve(dir, "release.json"), "utf8"),
      );
      if (old.digest !== value.digest)
        throw new HttpError(
          409,
          msg(
            "api.content-registry.published-versions-are-immutable-increase-the-version-number",
          ),
        );
    }
    await writeFile(resolve(dir, "plugin.ts"), value.source, {
      flag: "wx",
    }).catch((error: any) => {
      if (error.code !== "EEXIST") throw error;
    });
    return output;
  }
  async list() {
    const dirs = await readdir(resolve(this.root, "packages")).catch(() => []);
    return Promise.all(
      dirs.map(async (dir) =>
        JSON.parse(
          await readFile(
            resolve(this.root, "packages", dir, "release.json"),
            "utf8",
          ),
        ),
      ),
    );
  }
  async checkedDraft(id: string, source: string, config: unknown) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new HttpError(400, msg("api.content-registry.invalid-draft-id"));
    const draft = JSON.parse(
      await readFile(resolve(this.root, "drafts", `${id}.json`), "utf8"),
    );
    if (
      draft.source !== source ||
      !draft.report.passed ||
      draft.configurationHash !==
        createHash("sha256")
          .update(JSON.stringify(configSchema.parse(config)))
          .digest("hex")
    )
      throw new Error(
        msg(
          "api.content-registry.the-agent-source-or-configuration-differs-from-the-validated",
        ),
      );
    return draft;
  }
}

export async function contentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  registry: ContentRegistry,
  service: string,
): Promise<boolean> {
  if (!path.startsWith("/api/content/")) return false;
  try {
    if (path === "/api/content/protocol" && req.method === "GET")
      json(res, 200, {
        schema: z.toJSONSchema(contentPackageSchema),
        editPlanSchema: z.toJSONSchema(editPlanSchema),
        sdk: await readFile(
          fileURLToPath(
            new URL("../../../harness/authoring/sdk.d.ts", import.meta.url),
          ),
          "utf8",
        ),
        ...JSON.parse(
          await readFile(
            fileURLToPath(
              new URL("../../../harness/authoring/tools.json", import.meta.url),
            ),
            "utf8",
          ),
        ),
      });
    else if (
      /^\/api\/content\/skills\/(assets|terrain|appearance|editing|regions|water)$/.test(
        path,
      ) &&
      req.method === "GET"
    )
      json(res, 200, {
        text: await readFile(
          fileURLToPath(
            new URL(
              `../../../harness/authoring/skills/${path.split("/").at(-1)}.md`,
              import.meta.url,
            ),
          ),
          "utf8",
        ),
      });
    else if (path === "/api/content/packages" && req.method === "GET")
      json(res, 200, { packages: await registry.list() });
    else if (
      /^\/api\/content\/edits\/[a-f0-9-]{36}\/receipt$/.test(path) &&
      req.method === "POST"
    ) {
      if (
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin &&
          new URL(req.headers.origin).host !== req.headers.host)
      )
        throw new HttpError(
          403,
          msg(
            "api.content-registry.submit-application-results-from-this-workspace",
          ),
        );
      const requestId = path.split("/")[4];
      const edit = JSON.parse(
        await readFile(
          resolve(registry.root, "edits", `${requestId}.json`),
          "utf8",
        ),
      );
      const receipt = z
        .object({
          worldId: z.string(),
          status: z.enum(["applied", "partial", "rejected"]),
          revision: z.number().int().optional(),
          error: z.string().max(4000).optional(),
          regionReport: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .parse(await readJson(req, 256000));
      if (receipt.worldId !== edit.request.worldId)
        throw new HttpError(
          409,
          msg(
            "api.content-registry.the-application-result-belongs-to-a-different-world",
          ),
        );
      await writeFile(
        resolve(registry.root, "edits", `${requestId}.receipt.json`),
        JSON.stringify(
          { requestId, ...receipt, receivedAt: new Date().toISOString() },
          null,
          2,
        ),
      );
      json(res, 200, { saved: true });
    } else if (path === "/api/content/edit" && req.method === "POST") {
      if (
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin &&
          new URL(req.headers.origin).host !== req.headers.host)
      )
        throw new HttpError(
          403,
          msg("api.content-registry.edit-the-scene-from-this-workspace"),
        );
      const schema = z
        .object({
          requestId: z.string().uuid(),
          worldId: z.string().max(80),
          replyLocale: z.enum(["en", "zh-Hans"]).optional(),
          prompt: z.string().min(1).max(12000),
          selection: selectionSchema.nullable(),
          referenceIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8),
          config: configSchema,
          camera: z.object({
            x: z.number(),
            y: z.number(),
            z: z.number(),
            yaw: z.number(),
            pitch: z.number(),
          }),
          target: z
            .object({
              asset: storedObjectSchema.optional(),
              dynamic: dynamicEntitySchema.optional(),
            })
            .nullable()
            .optional(),
          context: z.record(z.string(), z.unknown()),
          history: z
            .array(
              z.object({
                role: z.enum(["user", "assistant"]),
                text: z.string().max(1500),
              }),
            )
            .max(12),
        })
        .strict();
      const request = schema.parse(await readJson(req, 2 * 1024 * 1024));
      const response = await fetch(
        new URL("/api/render/content/edit", service),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept-Language": req.headers["accept-language"] ?? "en",
            Cookie: req.headers.cookie ?? "",
            Authorization: req.headers.authorization ?? "",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(330000),
        },
      );
      const result = (await response.json()) as any;
      if (!response.ok)
        throw new HttpError(
          response.status,
          result.detail ??
            msg(
              "api.content-registry.the-agent-service-is-temporarily-unavailable",
            ),
        );
      if (result.mode !== "api")
        throw new HttpError(
          502,
          msg("api.content-registry.expected-api-agent-response"),
        );
      const mode = "api";
      if (!result.plan) {
        if (typeof result.message !== "string" || !result.message.trim())
          throw new Error(
            msg(
              "api.content-registry.the-agent-returned-neither-an-edit-plan-nor-a",
            ),
          );
        json(res, 200, {
          message: result.message.slice(0, 4000),
          trace: result.trace ?? [],
          mode,
          model: result.model,
        });
        return true;
      }
      const plan = editPlanSchema.parse({
        ...result.plan,
        intent: request.prompt,
      });
      if (
        plan.requestId !== request.requestId ||
        plan.worldId !== request.worldId
      )
        throw new Error(
          msg(
            "api.content-registry.the-agent-edit-request-identity-does-not-match",
          ),
        );
      if (
        ["replace", "move", "delete", "constraint"].includes(plan.action) &&
        (request.selection?.kind !== "object" ||
          plan.targetId !== request.selection.objectId ||
          plan.expectedVersion !== (request.selection.version ?? 0))
      )
        throw new Error(
          msg(
            "api.content-registry.the-agent-cannot-change-the-captured-target-or-its",
          ),
        );
      if (
        plan.action === "create" &&
        (request.selection?.kind !== "ground" ||
          JSON.stringify(plan.point) !==
            JSON.stringify(request.selection.point))
      )
        throw new Error(
          msg(
            "api.content-registry.the-agent-cannot-change-the-captured-creation-anchor",
          ),
        );
      if (
        JSON.stringify(plan.referenceIds) !==
        JSON.stringify(request.referenceIds)
      )
        throw new Error(
          msg(
            "api.content-registry.the-agent-cannot-change-object-reference-bindings",
          ),
        );
      let release;
      if (["create", "replace", "future"].includes(plan.action)) {
        if (typeof result.source !== "string" || !result.source.trim())
          throw new Error(
            msg(
              "api.content-registry.new-content-is-missing-its-recipe-source",
            ),
          );
        const draft =
          mode === "api" && result.draftId
            ? await registry.checkedDraft(
                result.draftId,
                result.source,
                request.config,
              )
            : await registry.stage(
                result.source,
                request.config,
                result.trace,
                {
                  prompt: request.prompt,
                  protectedChunks: (request.context.authoring as any)
                    ?.protectedChunks,
                },
              );
        if (
          plan.action !== "future" &&
          (!plan.asset || !draft.package.assets[plan.asset])
        )
          throw new Error(
            msg(
              "api.content-registry.the-edit-references-an-asset-that-has-not-passed",
            ),
          );
        release = await registry.publish(draft.id);
      }
      await mkdir(resolve(registry.root, "edits"), { recursive: true });
      const answer = {
        plan,
        release,
        trace: result.trace,
        mode,
        model: result.model,
      };
      await writeFile(
        resolve(registry.root, "edits", `${request.requestId}.json`),
        JSON.stringify({ request, ...answer }, null, 2),
      );
      json(res, 200, answer);
    } else if (path === "/api/content/validate" && req.method === "POST") {
      const request = (await readJson(req, 2 * 1024 * 1024)) as Record<
        string,
        any
      >;
      const context = z
        .object({
          protectedChunks: z
            .array(z.string().regex(/^-?\d+,-?\d+$/))
            .max(100000)
            .optional(),
          prompt: z.string().max(12000).optional(),
        })
        .parse(request.context ?? {});
      json(
        res,
        201,
        await registry.stage(request.source, request.config, [], context),
      );
    } else if (path === "/api/content/publish" && req.method === "POST") {
      const request = (await readJson(req, 4096)) as { id: string };
      json(res, 201, await registry.publish(request.id));
    } else
      throw new HttpError(
        404,
        msg("api.content-registry.content-endpoint-not-found"),
      );
  } catch (error) {
    json(res, error instanceof HttpError ? error.status : 400, {
      error: (error as Error).message,
    });
  }
  return true;
}

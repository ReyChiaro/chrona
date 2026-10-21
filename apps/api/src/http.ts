import {
  annotatePayload,
  describeMessage,
} from "../../../packages/i18n/src/index";
import { requestLocale } from "./locale";
import { msg } from "../../../packages/i18n/src/index";
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Language": requestLocale(),
    Vary: "Accept-Language",
  });
  const body = annotatePayload(value, requestLocale());
  const descriptor = describeMessage(
    (value as any)?.error ?? (value as any)?.detail,
  );
  if (descriptor) {
    body.code = descriptor.key;
    body.params = descriptor.params ?? {};
  }
  response.end(JSON.stringify(body));
}
export async function readJson(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      throw new HttpError(
        413,
        msg("api.http.the-request-exceeds-the-size-limit"),
      );
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(
      400,
      msg("api.http.the-request-must-contain-valid-json"),
    );
  }
}

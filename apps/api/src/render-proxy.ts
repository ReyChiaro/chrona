import { json } from "./http";
import { msg } from "../../../packages/i18n/src/index";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Same-origin streaming transport; large recordings never pass through JSON parsers. */
export function proxyRender(
  request: IncomingMessage,
  response: ServerResponse,
  base: string,
): void {
  const target = new URL(request.url!, base);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const upstream = send(
    target,
    {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    },
    (result) => {
      response.writeHead(result.statusCode ?? 502, result.headers);
      result.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (response.headersSent) {
      response.end();
      return;
    }
    json(response, 503, {
      detail: msg(
        "api.render-proxy.the-video-service-is-unavailable-check-the-rendering-service",
      ),
    });
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

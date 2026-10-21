import { msg } from '../../../packages/i18n/src/index';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, readJson } from './http';

/** Owner-authenticated settings; public status exposes no endpoint or credential. */
export async function agentRoutes(req: IncomingMessage, res: ServerResponse, path: string, service: string): Promise<boolean> {
  if (!/^\/api\/content\/agent(?:$|\/(?:status|test|unlock|lock)$|\/runs\/[a-f0-9-]{36}$)/.test(path)) return false;
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new HttpError(403, msg('api.agent-routes.open-agent-settings-from-this-workspace'));
    const allowed = path === '/api/content/agent' ? ['GET', 'PUT'] : /\/(?:status|runs\/[a-f0-9-]{36})$/.test(path) ? ['GET'] : ['POST'];
    if (!allowed.includes(req.method ?? '')) throw new HttpError(405, msg('api.agent-routes.this-request-method-is-not-supported'));
    const body = ['PUT', 'POST'].includes(req.method ?? '') ? await readJson(req, 32768) : undefined;
    const response = await fetch(new URL(path.replace('/api/content/agent', '/api/render/content/agent'), service), {
      method: req.method, headers: { 'Content-Type': 'application/json', 'Accept-Language': req.headers['accept-language'] ?? 'en', Cookie: req.headers.cookie ?? '', Authorization: req.headers.authorization ?? '' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path.endsWith('/test') ? 330000 : 10000),
    });
    const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('Set-Cookie', cookies);
    json(res, response.status, await response.json());
  } catch (error) {
    json(res, error instanceof HttpError ? error.status : 503, { error: error instanceof HttpError ? error.message : msg('api.agent-routes.the-code-agent-service-is-unavailable-check-the-python') });
  }
  return true;
}

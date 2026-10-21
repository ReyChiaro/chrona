import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/api/src/index';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';

test('API edits reuse real compile/publish contracts, bind host identity, without requiring server access tokens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-contract-'));
  const previous = { content: process.env.CONTENT_DATA_DIR, service: process.env.RENDER_SERVICE_URL };
  const recipe = JSON.parse(await readFile(new URL('./fixtures/stone-well.json', import.meta.url), 'utf8'));
  const source = `export default defineContent(${JSON.stringify(recipe)});`;
  let origin = '', retarget = false, calls = 0;
  const backend = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    if (req.url !== '/api/render/content/edit') { res.end(JSON.stringify({ mode: 'api', hasApiKey: true })); return; }
    calls++;
    const protocol = await (await fetch(`${origin}/api/content/protocol`)).json(); assert.ok(protocol.editPlanSchema && protocol.sdk);
    const checked = await fetch(`${origin}/api/content/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, config: data.config }) });
    assert.equal(checked.status, 201); const draft = await checked.json();
    res.end(JSON.stringify({ mode: 'api', model: 'test-api-model', draftId: draft.id, source, trace: [{ tool: 'compile_validate_stage', status: 'ok' }],
      plan: { requestId: data.requestId, worldId: data.worldId, label: '新增苔石水井', action: 'create', asset: 'well', point: retarget ? { x: 99, y: 0, z: 99 } : data.selection.point,
        referenceIds: data.referenceIds, constraint: 'mossy stone well and blue water' } }));
  });
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve));
  const address = backend.address(); assert.ok(address && typeof address !== 'string');
  process.env.CONTENT_DATA_DIR = root; process.env.RENDER_SERVICE_URL = `http://127.0.0.1:${address.port}`;
  const app = await startServer({ port: 0, host: '127.0.0.1', frontend: false, dataDirectory: join(root, 'worlds') });
  const web = app.server.address(); assert.ok(web && typeof web !== 'string'); origin = `http://127.0.0.1:${web.port}`;
  try {
    const headers = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${origin}/api/content/agent/unlock`, { method: 'POST', headers, body: '{}' })).status, 404);
    assert.equal((await fetch(`${origin}/api/content/agent/lock`, { method: 'POST', headers, body: '{}' })).status, 404);
    const config = await fetch(`${origin}/api/content/agent`, { headers }); assert.equal((await config.json()).mode, 'api');
    const data = { requestId: crypto.randomUUID(), worldId: crypto.randomUUID(), prompt: '新增一座苔石水井', selection: { kind: 'ground', label: '地面', point: { x: 8, y: 2, z: -5 } },
      camera: { x: 8, y: 4, z: 1, yaw: 0, pitch: 0 }, referenceIds: ['a'.repeat(64)], context: {}, history: [], config: DEFAULT_CONFIG };
    const response = await fetch(`${origin}/api/content/edit`, { method: 'POST', headers, body: JSON.stringify(data) });
    assert.equal(response.status, 200); const result = await response.json();
    assert.equal(result.mode, 'api'); assert.equal(result.release.package.assets.well.label, '苔石水井'); assert.equal(result.release.published, true);
    assert.deepEqual(result.plan.point, data.selection.point); assert.deepEqual(result.plan.referenceIds, data.referenceIds);
    retarget = true;
    const rejected = await fetch(`${origin}/api/content/edit`, { method: 'POST', headers, body: JSON.stringify({ ...data, requestId: crypto.randomUUID() }) });
    assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /anchor/);
    const blocked = await fetch(`${origin}/api/content/edit`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify(data) });
    assert.equal(blocked.status, 403); assert.equal(calls, 2);
    assert.equal((await fetch(`${origin}/api/content/agent`, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  } finally {
    await app.close(); await new Promise<void>(resolve => backend.close(() => resolve()));
    if (previous.content === undefined) delete process.env.CONTENT_DATA_DIR; else process.env.CONTENT_DATA_DIR = previous.content;
    if (previous.service === undefined) delete process.env.RENDER_SERVICE_URL; else process.env.RENDER_SERVICE_URL = previous.service;
    await rm(root, { recursive: true, force: true });
  }
});

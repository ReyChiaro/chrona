import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../apps/api/src/index';
import { initializePhysics, WorldRuntime } from '../packages/adapters/src/rapier/runtime';
import { DEFAULT_CONFIG } from '../packages/protocol/src/config';

test('HTTP persistence survives reloads, queues atomic writes, and rejects malformed or incompatible data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrona-test-'));
  const app = await startServer({ port: 0, frontend: false, dataDirectory: directory });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  try {
    const snapshot = JSON.parse(JSON.stringify(world.snapshot(true)));
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
    const metadataOnly = { ...snapshot, execution: undefined };
    assert.equal((await fetch(`${url}/api/worlds/${snapshot.id}`, { method: 'PUT', body: JSON.stringify(metadataOnly) })).status, 400);
    const save = await fetch(`${url}/api/worlds/${snapshot.id}`, { method: 'PUT', body: JSON.stringify(snapshot) });
    assert.equal(save.status, 200);
    const loaded = await (await fetch(`${url}/api/worlds/${snapshot.id}`)).json();
    assert.deepEqual(loaded, snapshot);
    const list = await (await fetch(`${url}/api/worlds`)).json(); assert.equal(list.worlds.length, 1);
    assert.equal(list.worlds[0].chunks, 7);
    await Promise.all(Array.from({ length: 5 }, (_, tick) => app.store.write({ ...snapshot, tick })));
    assert.equal((await app.store.read(snapshot.id)).tick, 4);
    assert.equal((await fetch(`${url}/api/worlds/${snapshot.id}`, { method: 'PUT', body: JSON.stringify(snapshot) })).status, 409);
    assert.equal((await app.store.read(snapshot.id)).tick, 4);
    assert.deepEqual(await readdir(directory), [`${snapshot.id}.json`]);
    assert.equal((await fetch(`${url}/api/worlds/missing`)).status, 404);
    assert.equal((await fetch(`${url}/api/worlds/${snapshot.id}`, { method: 'PUT', body: '{broken' })).status, 400);
    assert.equal((await fetch(`${url}/api/worlds/${snapshot.id}`, { method: 'PUT', body: JSON.stringify({ ...snapshot, id: '../bad' }) })).status, 400);
    assert.equal((await fetch(`${url}/api/worlds/${snapshot.id}`, { method: 'PUT', body: JSON.stringify({ ...snapshot, generatorVersion: 'unknown' }) })).status, 409);
    assert.equal((await fetch(`${url}/api/integrations/video`, { method: 'POST' })).status, 501);
    await assert.rejects(app.store.read('../escape'), /Invalid/);
  } finally { world.dispose(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('new writer claims return the last checkpoint and fence delayed saves from the previous page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrona-session-test-'));
  const app = await startServer({ port: 0, frontend: false, dataDirectory: directory });
  await initializePhysics(); const world = new WorldRuntime(structuredClone(DEFAULT_CONFIG));
  const address = app.server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}/api/worlds/${world.id}`;
  try {
    const first = await (await fetch(`${url}/session`, { method: 'POST' })).json(); assert.equal(first.snapshot, null);
    const original = JSON.parse(JSON.stringify(world.snapshot(true)));
    assert.equal((await fetch(url, { method: 'PUT', headers: { 'X-Chrona-Session': first.token }, body: JSON.stringify(original) })).status, 200);
    const second = await (await fetch(`${url}/session`, { method: 'POST' })).json(); assert.equal(second.snapshot.tick, original.tick);
    assert.equal((await fetch(url, { method: 'PUT', headers: { 'X-Chrona-Session': first.token }, body: JSON.stringify({ ...original, tick: original.tick + 100 }) })).status, 409);
    assert.equal((await fetch(url, { method: 'PUT', headers: { 'X-Chrona-Session': second.token }, body: JSON.stringify(original) })).status, 200);
    assert.equal((await app.store.read(world.id)).tick, original.tick);
  } finally { world.dispose(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

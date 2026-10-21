import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
async function files(root: string): Promise<string[]> { const items = await readdir(root, { withFileTypes: true }); return (await Promise.all(items.map(item => item.isDirectory() ? files(`${root}/${item.name}`) : Promise.resolve([`${root}/${item.name}`])))).flat(); }
test('domain and canonical schemas have no physics, host, view, network or model dependencies', async () => {
  for (const root of ['packages/world/src', 'contracts/schemas']) for (const file of await files(root)) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(file, 'utf8');
    for (const [, dependency] of source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) assert.ok(!/adapters|viewer|apps|three|rapier|node:|chrona/.test(dependency), `${file}: ${dependency}`);
    assert.ok(!/\b(?:document|localStorage|fetch)\s*[.(]/.test(source), file);
  }
});
test('renderer cannot import world storage or authoring and authoring does not import GPU providers', async () => {
  for (const file of await files('src/chrona/rendering')) if (file.endsWith('.py')) assert.ok(!/from chrona\.(?:authoring|world)/.test(await readFile(file, 'utf8')), file);
  for (const file of await files('src/chrona/authoring')) if (file.endsWith('.py')) assert.ok(!/from chrona\.(?:rendering|adapters\.providers)|^import (?:torch|diffusers)/m.test(await readFile(file, 'utf8')), file);
});
test('viewer reads world ports and the application cannot import Rapier execution directly', async () => {
  for (const root of ['packages/viewer/src','apps/web/src']) for (const file of await files(root)) if (file.endsWith('.ts')) assert.ok(!/adapters\/src\/rapier|from ['"]@dimforge/.test(await readFile(file, 'utf8')), file);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer } from '../apps/api/src/index';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { annotatePayload, countMessage, escapeHtml, formatCount, formatMessage, getLocale, localeRegistry, localizePayload, msg, negotiateLocale, normalizeLocale, setLocale, t } from '../packages/i18n/src/index';

test('catalogs have identical keys and interpolation parameters', async () => {
  const en = JSON.parse(await readFile('locales/en.json', 'utf8'));
  const zh = JSON.parse(await readFile('locales/zh-Hans.json', 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(en)) {
    assert.ok(en[key].trim(), key); assert.ok(zh[key].trim(), key);
    assert.deepEqual(en[key].match(/\{[a-zA-Z]\w*\}/g)?.sort(), zh[key].match(/\{[a-zA-Z]\w*\}/g)?.sort(), key);
    assert.ok(!/[\u3400-\u9fff]/.test(en[key]), key);
  }
});
test('English is the default; aliases, weighted negotiation and reserved languages are explicit', () => {
  assert.equal(getLocale(), 'en');
  assert.equal(normalizeLocale('zh_CN'), 'zh-Hans');
  assert.equal(normalizeLocale('zh-Hant'), 'en'); assert.equal(normalizeLocale('ja'), 'en');
  assert.equal(negotiateLocale('ja;q=1, zh-CN;q=0.8, en;q=0.5'), 'zh-Hans');
  assert.equal(negotiateLocale('zh;q=0,en;q=1'), 'en');
  assert.equal(negotiateLocale('zh;q=oops,en'), 'en');
  assert.deepEqual(localeRegistry.filter(locale => !locale.enabled).map(locale => locale.code), ['ja', 'zh-Hant']);
});
test('presentation changes language while canonical values and user data stay stable', () => {
  const phase = msg('ui.layout.waiting-for-a-recording');
  const raw = { phase, name: '我的世界', label: '雪松河谷', prompt: '保留这段输入', history: ['樱花树'] };
  const annotated = annotatePayload(raw);
  assert.equal(localizePayload(annotated, 'zh-Hans').phase, '等待录制');
  assert.equal(localizePayload(annotated, 'en').phase, phase);
  assert.equal(raw.phase, phase); assert.equal(raw.name, '我的世界');
  assert.equal(localizePayload(annotated, 'zh-Hans').label, '雪松河谷');
  setLocale('zh-Hans');
  try { assert.equal(t('ui.layout.save-world'), '保存世界'); assert.equal(msg('ui.layout.save-world'), 'Save world'); }
  finally { setLocale('en'); }
  assert.equal(formatMessage('unknown.key'), 'unknown.key');
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});
test('updated persisted messages replace old descriptors instead of reverting task progress', () => {
  const old = annotatePayload({ phase: msg('ui.layout.waiting-for-a-recording') });
  const next = annotatePayload({ ...old, phase: msg('ui.layout.start-recording') });
  assert.equal(localizePayload(next, 'zh-Hans').phase, '开始录制');
  const external = annotatePayload({ ...next, phase: 'External provider phase' });
  assert.equal(localizePayload(external, 'zh-Hans').phase, 'External provider phase');
});
test('localization preserves binary geometry, maps and other structured-clone values', () => {
  const positions = new Float32Array([1, 2, 3]), indices = new Uint32Array([0, 1, 2]);
  const value = { chunks: [{ positions, indices }], map: new Map([['id', 1]]), date: new Date(0) };
  const result = localizePayload(annotatePayload(value), 'zh-Hans');
  assert.equal(result.chunks[0].positions, positions); assert.equal(result.chunks[0].indices, indices);
  assert.equal(result.map, value.map); assert.equal(result.date, value.date);
});
test('cleared errors stay cleared and unknown data keys survive localization', () => {
  const failed = annotatePayload({ error: msg('ui.layout.waiting-for-a-recording'), warnings: [msg('ui.layout.start-recording')] });
  const succeeded = localizePayload(annotatePayload({ ...failed, error: null, warnings: [] }), 'zh-Hans');
  assert.equal(succeeded.error, null); assert.deepEqual(succeeded.warnings, []);
  const value = JSON.parse('{"__proto__":{"preserved":true},"label":"用户名称"}');
  const result = localizePayload(annotatePayload(value));
  assert.ok(Object.hasOwn(result, '__proto__')); assert.deepEqual(result.__proto__, { preserved: true });
  assert.equal(formatMessage('constructor'), 'constructor');
});
test('plural counts and nested message parameters follow presentation language', () => {
  assert.equal(formatCount(1, 'chunk'), '1 chunk'); assert.equal(formatCount(2, 'chunk'), '2 chunks');
  const params = { rings: countMessage(1, 'ring'), chunks: countMessage(1, 'chunk') };
  assert.equal(formatMessage('ui.main.rings-chunks', params, 'en'), '1 ring · 1 chunk');
  assert.equal(formatMessage('ui.main.rings-chunks', params, 'zh-Hans'), '1 层 · 1 个区块');
});
test('concurrent Node requests negotiate independently and return stable error codes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrona-i18n-'));
  const app = await startServer({ port: 0, frontend: false, dataDirectory: directory });
  try {
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const results = await Promise.all(['en', 'zh-CN', 'en', 'zh-Hans'].map(async language => {
      const response = await fetch(base + '/api/missing', { headers: { 'Accept-Language': language } });
      assert.equal(response.status, 404);
      return { language, contentLanguage: response.headers.get('content-language'), body: await response.json() };
    }));
    for (const result of results) {
      const chinese = result.language.startsWith('zh');
      assert.equal(result.contentLanguage, chinese ? 'zh-Hans' : 'en');
      assert.equal(result.body.error, chinese ? '接口不存在' : 'API endpoint not found.');
      assert.equal(result.body.code, 'api.index.api-endpoint-not-found');
    }
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

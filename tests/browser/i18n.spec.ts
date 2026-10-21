import { test, expect } from '@playwright/test';

// These scenarios start exactly as a new visitor, independent of the Chinese
// storage used by the pre-existing interface regression scenarios.
test.use({ storageState: { cookies: [], origins: [] } });

async function ready(page: import('@playwright/test').Page) {
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
}
test('a fresh visitor gets English throughout the workspace and dialogs', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#language-select')).toHaveValue('en');
  await expect(page.getByRole('button', { name: 'Save world', exact: true })).toBeVisible();
  await page.locator('#settings-toggle').click();
  await expect(page.locator('#settings')).toContainText('Shape your world');
  await expect(page.locator('#settings-fields')).toContainText('World seed');
  await page.locator('#settings-close').click();
  await page.locator('#video-settings-toggle').click();
  await expect(page.locator('#render-dialog')).toContainText('Generate video');
  await page.locator('#render-dialog-close').click();
  await page.locator('#composer-toggle').click();
  await page.locator('#composer-agent-settings').click();
  await expect(page.locator('#agent-settings')).toContainText('Server access token');
  await page.locator('#agent-settings-close').click(); await page.locator('#composer-close').click();
  const hardcoded = await page.evaluate(() => {
    const root = document.querySelector('#app')!.cloneNode(true) as HTMLElement;
    root.querySelectorAll('select,input,textarea').forEach(element => element.remove());
    return root.textContent!.match(/[\u3400-\u9fff]+/g) ?? [];
  });
  expect(hardcoded).toEqual([]); expect(errors).toEqual([]);
});

test('language changes preserve world identity, camera, physics and unsent input', async ({ page }) => {
  await ready(page);
  const before = await page.evaluate(async () => {
    const world = window.chrona.runtime; await world.pause(true);
    return { id: world.id, camera: { ...world.camera }, tick: world.clock.tick, revision: world.content.state.revision };
  });
  await page.locator('#composer-toggle').click(); await page.locator('#composer-prompt').fill('保留我的输入 · Keep my input');
  await page.locator('#language-select').selectOption('zh-Hans');
  await expect(page.getByRole('button', { name: '保存世界', exact: true })).toBeVisible();
  await expect(page.locator('#composer-prompt')).toHaveValue('保留我的输入 · Keep my input');
  await expect(page.locator('#composer-prompt')).toHaveAttribute('placeholder', /樱花树/);
  const after = await page.evaluate(() => {
    const world = window.chrona.runtime;
    return { id: world.id, camera: { ...world.camera }, tick: world.clock.tick, revision: world.content.state.revision };
  });
  expect({ id: after.id, tick: after.tick, revision: after.revision }).toEqual({ id: before.id, tick: before.tick, revision: before.revision });
  // Rapier uses float32 coordinates while the read model uses JS numbers.
  // Settling can round the observer by sub-micrometre amounts while paused.
  for (const coordinate of ['x', 'y', 'z', 'yaw', 'pitch'] as const) expect(after.camera[coordinate]).toBeCloseTo(before.camera[coordinate], 5);
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#composer-prompt')).toHaveAttribute('placeholder', /cherry tree/);
});

test('selection is remembered and an explicit URL language takes precedence', async ({ page }) => {
  await ready(page); const id = await page.evaluate(() => window.chrona.runtime.id);
  await page.locator('#language-select').selectOption('zh-Hans'); await page.reload();
  await page.waitForFunction(() => window.chrona?.ready);
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  expect(await page.evaluate(() => window.chrona.runtime.id)).toBe(id);
  await page.goto('/?lang=en'); await page.waitForFunction(() => window.chrona?.ready);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.locator('#language-select').selectOption('zh-Hans');
  expect(new URL(page.url()).searchParams.get('lang')).toBe('zh-Hans');
  await page.goto('/?lang=ja'); await page.waitForFunction(() => window.chrona?.ready);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#language-select option')).toHaveCount(2);
});

test('foreign browser storage does not become a Chrona world or conversation', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('dynamic-world:last-world', 'foreign-world');
    localStorage.setItem('dynamic-world:conversation:foreign-world', JSON.stringify([{ role: 'user', text: 'Foreign conversation' }]));
  });
  await ready(page);
  expect(await page.evaluate(() => window.chrona.runtime.id)).not.toBe('foreign-world');
  expect(await page.evaluate(() => 'dynamicWorld' in window)).toBe(false);
  await page.locator('#composer-toggle').click();
  await expect(page.locator('.message-user')).toHaveCount(0);
});

test('Worker errors retain the same code and follow the active language', async ({ page }) => {
  await ready(page);
  const failure = () => page.evaluate(async () => {
    try { await window.chrona.runtime.editor.undo(); return { code: '', message: '' }; }
    catch (error) { return { code: (error as Error & { code: string }).code, message: (error as Error).message }; }
  });
  const english = await failure(); expect(english.message).toContain('no edits to undo');
  await page.locator('#language-select').selectOption('zh-Hans');
  const chinese = await failure(); expect(chinese.message).toContain('没有可撤销的编辑'); expect(chinese.code).toBe(english.code);
});

test('user names and conversation text that match UI wording are never translated', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const runtime = window.chrona.runtime;
    await runtime.rename('Save world'); await window.chrona.save();
    localStorage.setItem(`chrona:conversation:${runtime.id}`, JSON.stringify([{ role: 'user', text: 'Save world' }]));
  });
  await page.reload(); await page.waitForFunction(() => window.chrona?.ready);
  await page.locator('#composer-toggle').click(); await page.locator('#language-select').selectOption('zh-Hans');
  await expect(page.locator('#world-name')).toHaveText('Save world');
  await expect(page.locator('.message-user')).toHaveText('Save world');
  expect(await page.evaluate(() => window.chrona.runtime.name)).toBe('Save world');
});

test('editing without a configured model reports an error without changing the world', async ({ page }) => {
  await ready(page);
  const revision = await page.evaluate(() => window.chrona.runtime.content.state.revision);
  await page.locator('#composer-toggle').click();
  await page.locator('#composer-prompt').fill('Create a lantern here');
  await page.locator('#composer-send').click();
  await expect(page.locator('#composer-messages')).toContainText('Configure and enable the code model');
  expect(await page.evaluate(() => window.chrona.runtime.content.state.revision)).toBe(revision);
});

test('switching during recording keeps the recorder and world session alive', async ({ page }) => {
  await ready(page); const id = await page.evaluate(() => window.chrona.runtime.id);
  await expect(page.locator('#record-toggle')).toBeEnabled(); await page.locator('#record-toggle').click();
  await expect(page.locator('#record-toggle')).toHaveClass(/recording/); await page.keyboard.press('Escape');
  await page.locator('#language-select').selectOption('zh-Hans');
  await expect(page.locator('#record-toggle')).toHaveClass(/recording/);
  expect(await page.evaluate(() => window.chrona.runtime.id)).toBe(id);
  await page.waitForTimeout(300); await page.locator('#record-toggle').click();
  await expect(page.locator('#record-toggle')).not.toHaveClass(/recording/);
});


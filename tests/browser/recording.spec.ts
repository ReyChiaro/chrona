import { test, expect } from '@playwright/test';
import { expectUnobscuredViews } from './view-layout';

for (const prompt of ['Natural materials', '']) {
  test(`records and renders a camera take ${prompt ? 'with a description' : 'without a description'}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const identifier = '12345678-1234-4234-8234-123456789abc';
    let uploaded = false, submitted = false;
    await page.route('**/api/render/prompt-enhancement/status', route => route.fulfill({ json: {
      configured: true, defaultEnabled: false, label: 'MiniMax H3-Context-IR',
    } }));
    let resultVideo: Buffer;
    await page.route('**/api/render/capabilities', route => route.fulfill({ json: {
      enabled: true, providerState: 'ready', providerError: '', label: 'Test adapter', prompt: 'Natural materials', systemPrompt: 'Preserve geometry',
      recording: { fps: 24, width: 480, height: 288, bitsPerSecond: 2000000 },
      fps: 24, minFrames: 5, maxFrames: 48, frameMultiple: 4, frameOffset: 1,
      parameters: [{ key: 'seed', label: '种子', type: 'number', default: 42, min: 0, max: 100, step: 1 },
        { key: 'steps', label: '采样步数', type: 'number', default: 30, min: 2, max: 100, step: 1 }], conditions: {},
      adapters: { maxActive: 4, maxScale: 2, items: [{ id: 'a'.repeat(24), label: 'watercolor.safetensors', sha256: 'b'.repeat(64), kind: 'lora' }] },
    } }));
    await page.route('**/api/render/recordings', async route => {
      const request = route.request();
      const form = await new Response(new Uint8Array(request.postDataBuffer()!), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
      const video = form.get('video') as File;
      const metadata = JSON.parse(await (form.get('metadata') as File).text());
      expect(video.size).toBeGreaterThan(10000);
      expect(video.type).toContain('video/');
      resultVideo = Buffer.from(await video.arrayBuffer());
      expect(metadata.width).toBe(480); expect(metadata.height).toBe(288);
      expect(metadata.world.config.seed).toBeTruthy();
      expect(metadata.world.generatorVersion).toBeTruthy();
      expect(metadata.duration).toBeGreaterThanOrEqual(1);
      expect(metadata.observations.length).toBeGreaterThan(10);
      expect(metadata.observations[0].observation.viewport.width).toBe(480);
      expect(metadata.observations.at(-1).observation.camera.z).toBeGreaterThan(metadata.observations[0].observation.camera.z + 2);
      expect(metadata.observations.every((entry: { time: number }, i: number) => i === 0 || entry.time > metadata.observations[i - 1].time)).toBe(true);
      uploaded = true;
      await route.fulfill({ status: 201, json: { id: identifier } });
    });
    const job = { id: identifier, recordingId: identifier, status: 'succeeded', phase: '生成完成', progress: 1,
      createdAt: Date.now() / 1000, error: null, videoUrl: '/test-result.mp4' };
    await page.route('**/api/render/jobs', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        expect(body.recording_id).toBe(identifier); expect(body.prompt).toBe(prompt);
        expect(body.system_prompt).toBe('Preserve geometry');
        expect(body.frame_stride).toBe(3);
        expect(body.segment_seconds).toBe(3.5); expect(body.overlap_frames).toBe(9);
        expect(body.budgets).toEqual({ near: 12, middle: 8, far: 4 });
        expect(body.parameters.steps).toBe(37);
        expect(body.prompt_enhancement).toBe(Boolean(prompt));
        expect(body.adapters).toEqual([{ id: 'a'.repeat(24), scale: 0.65 }]);
        submitted = true;
        await route.fulfill({ status: 202, json: { ...job, status: 'queued' } });
      } else await route.fulfill({ json: { jobs: submitted ? [job] : [] } });
    });
    await page.route(`**/api/render/jobs/${identifier}`, route => route.fulfill({ json: job }));
    await page.route('**/test-result.mp4', route => route.fulfill({ status: 200, contentType: 'video/webm', body: resultVideo }));
    await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
    await expect(page.locator('#record-toggle')).toBeEnabled();
    await page.locator('#record-toggle').click(); await page.keyboard.down('w');
    await page.waitForTimeout(2400);
    await expect(page.locator('#record-toggle')).toHaveClass(/recording/);
    await expect(page.locator('#take-actions')).toHaveJSProperty('hidden', true);
    await expect(page.locator('#record-label')).toContainText('帧');
    await page.keyboard.press('r');
    await expect(page.locator('#take-actions')).toHaveJSProperty('hidden', false);
    expect(await page.evaluate(async () => document.pointerLockElement?.id)).toBe('first-canvas');
    const afterStop = await page.evaluate(async () => window.chrona.observe().camera.z);
    await expect.poll(() => page.evaluate(async () => window.chrona.observe().camera.z)).toBeGreaterThan(afterStop + 1);
    await page.keyboard.up('w'); await page.keyboard.press('Escape');
    await page.locator('#video-settings-toggle').click();
    await expect(page.locator('#render-dialog')).toBeVisible();
    await expect(page.locator('#submit-render')).toBeEnabled();
    await expect(page.locator('#render-mode')).toHaveCount(0);
    await expect(page.locator('input[name=steps]')).toHaveValue('30');
    await expect(page.locator('input[name=steps]')).not.toHaveAttribute('readonly');
    await page.locator('input[name=steps]').fill('37');
    await page.locator('#lora-options summary').click();
    await page.locator('#lora-list input[type=checkbox]').check();
    await page.locator('#lora-list input[type=number]').fill('0.65');
    await page.locator('#lora-refresh').click();
    await expect(page.locator('#lora-list input[type=number]')).toHaveValue('0.65');
    await expect(page.locator('input[name=steps]')).toHaveValue('37');
    await page.locator('#frame-stride').fill('3');
    await expect(page.locator('#recording-summary')).toContainText('帧条件');
    await page.locator('#video-source-toggle').click();
    await expect(page.locator('#source-video')).toBeVisible();
    await expect(page.locator('#render-dialog')).not.toBeVisible();
    await expectUnobscuredViews(page);
    await page.locator('#video-settings-toggle').click();
    await expect(page.locator('#render-prompt')).toHaveValue('Natural materials');
    await page.locator('#render-prompt').fill(prompt);
    if (prompt) await page.locator('#prompt-enhancement-enabled').check();
    await page.locator('#submit-render').click();
    await expect(page.locator('#render-phase')).toHaveText('生成完成');
    await expect(page.locator('#video-output')).toBeVisible();
    await expect(page.locator('#source-video')).toBeHidden();
    await expect(page.locator('#download-result')).toHaveAttribute('href', '/test-result.mp4');
    await expect.poll(() => page.locator('#video-output').evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
    await page.locator('#video-output').evaluate(async element => {
      const video = element as HTMLVideoElement; video.muted = true; await video.play();
    });
    await expect.poll(() => page.locator('#video-output').evaluate(video => (video as HTMLVideoElement).currentTime)).toBeGreaterThan(0.1);
    await page.locator('#video-output').evaluate(video => (video as HTMLVideoElement).pause());
    for (const width of [1440, 800, 640, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expectUnobscuredViews(page);
      await page.locator('#video-output').scrollIntoViewIfNeeded();
      expect(await page.locator('#video-output').evaluate(video => {
        const box = video.getBoundingClientRect();
        return document.elementFromPoint(box.left + box.width / 2, box.bottom - 20) === video;
      })).toBe(true);
    }
    await page.screenshot({ path: 'test-results/video-mobile.png', fullPage: true });
    expect(uploaded && submitted).toBe(true); expect(errors).toEqual([]);
  });
}

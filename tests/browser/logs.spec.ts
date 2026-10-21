import { test, expect } from '@playwright/test';
import { expectUnobscuredViews } from './view-layout';

test('logs are collapsed by default, show actual step progress, switch scopes and offer downloads', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const id = '12345678-1234-4234-8234-123456789abc';
  const job = { id, recordingId: id, status: 'running', phase: '正在采样 7/23', progress: 0.43,
    createdAt: Date.now() / 1000, error: null, videoUrl: null, stage: 'sampling', elapsedSeconds: 130,
    sampling: { completed: 7, total: 23, samplingSeconds: 120, samplingEtaSeconds: 200 } };
  await page.route('**/api/render/capabilities', route => route.fulfill({ json: {
    enabled: true, providerState: 'ready', providerError: '', label: 'Test provider', prompt: 'Natural scene', systemPrompt: 'Keep route',
    recording: { fps: 24, width: 480, height: 288, bitsPerSecond: 2000000 },
    fps: 24, minFrames: 5, maxFrames: 81, frameMultiple: 4, frameOffset: 1,
    samplingNote: '当前模型使用固定四步时间表',
    parameters: [{ key: 'steps', label: '采样步数', type: 'number', default: 4, min: 4, max: 4, step: 1 }], conditions: {},
  } }));
  await page.route('**/api/render/jobs', route => route.fulfill({ json: { jobs: [job] } }));
  await page.route(`**/api/render/jobs/${id}`, route => route.fulfill({ json: job }));
  let logRequests = 0;
  await page.route('**/api/render/**/logs?*', route => {
    logRequests++;
    const task = route.request().url().includes('/jobs/');
    const after = new URL(route.request().url()).searchParams.get('after');
    return route.fulfill({ json: { entries: after === '0' ? [{ timestamp: new Date().toISOString(), level: 'info',
      event: task ? 'sampling.step' : 'service.config', message: task ? '正在采样 7/23' : '渲染服务初始配置', jobId: task ? id : null,
      data: task ? { inputPath: 'recording/reference.mp4', completed: 7, total: 23 } : { modelPath: 'models/reference-model', device: 'cuda:0' } }] : [],
      cursor: 256, hasMore: false } });
  });
  await page.goto('/'); await page.waitForFunction(() => window.chrona?.ready);
  await expect(page.locator('#render-step-progress')).toHaveJSProperty('value', 7);
  await expect(page.locator('#render-step-progress')).toHaveJSProperty('max', 23);
  await expect(page.locator('#render-step-detail')).toContainText('30%');
  await expect(page.locator('#render-step-detail')).toContainText('采样约剩余');
  await expectUnobscuredViews(page);
  await expect(page.locator('#render-logs')).toHaveJSProperty('open', false);
  expect(logRequests).toBe(0);
  await page.locator('#render-log-toggle').click();
  await expect(page.locator('#render-log-content')).toBeVisible();
  await expect(page.locator('#render-log-content')).toContainText('recording/reference.mp4');
  await expect(page.locator('#render-log-download')).toHaveAttribute('href', `/api/render/jobs/${id}/logs/download`);
  await page.locator('#render-log-source').selectOption('service');
  await expect(page.locator('#render-log-content')).toContainText('models/reference-model');
  await expect(page.locator('#render-log-content')).not.toContainText('recording/reference.mp4');
  await expect(page.locator('#render-log-download')).toHaveAttribute('href', '/api/render/logs/download');
  await page.screenshot({ path: 'test-results/logs-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(async () => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectUnobscuredViews(page);
  await page.locator('#video-settings-toggle').click();
  await expect(page.locator('#render-mode')).toHaveCount(0);
  await expect(page.locator('#render-parameters input[name=steps]')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#sampling-note')).toContainText('固定四步');
  expect(errors).toEqual([]);
});

import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page) {
  await page.addInitScript(() => {
    const traffic = { inputs: 0, lookRPCs: 0, replies: 0, broadcasts: 0, frames: [] as { chunks: number; removed: number; reset: boolean; at: number }[] };
    (window as any).__roamingTraffic = traffic;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes('host.worker')) return;
        const post = this.postMessage.bind(this);
        this.postMessage = ((message: any, ...rest: any[]) => {
          if (message.method === 'input') traffic.inputs++;
          if (message.method === 'look') traffic.lookRPCs++;
          (post as any)(message, ...rest);
        }) as typeof this.postMessage;
        this.addEventListener('message', ({ data }) => {
          if (data.type === 'reply') traffic.replies++;
          const frame = data.type === 'frame' ? data.value : data.frame;
          if (frame) traffic.frames.push({ chunks: frame.chunks?.length ?? 0, removed: frame.removedChunks?.length ?? 0, reset: Boolean(frame.resetChunks), at: performance.now() });
        });
      }
    };
    const NativeChannel = window.BroadcastChannel;
    window.BroadcastChannel = class extends NativeChannel {
      postMessage(data: any) { if (data.type === 'frame') traffic.broadcasts++; super.postMessage(data); }
    };
  });
  await page.goto('/');
  await page.waitForFunction(() => window.chrona?.ready);
}

test('turning responds before the worker replies and thousands of mouse deltas are batched', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    const runtime = window.chrona.runtime, traffic = (window as any).__roamingTraffic;
    const before = { ...runtime.camera }, replies = traffic.replies, inputs = traffic.inputs;
    for (let i = 0; i < 1000; i++) runtime.look(.1, -.01);
    const displayed = runtime.presentationCamera(performance.now());
    const authoritativeUnchanged = runtime.camera.yaw === before.yaw;
    await runtime.pause(true); // flush pending look, then wait for authoritative acknowledgement
    return { authoritativeUnchanged, immediateDelta: displayed.yaw - before.yaw, finalDelta: runtime.camera.yaw - before.yaw,
      inputs: traffic.inputs - inputs, replies: traffic.replies - replies, lookRPCs: traffic.lookRPCs, broadcasts: traffic.broadcasts };
  });
  expect(result.authoritativeUnchanged).toBe(true);
  expect(Math.abs(result.immediateDelta)).toBeGreaterThan(.1);
  expect(result.finalDelta).toBeCloseTo(result.immediateDelta, 8);
  expect(result.lookRPCs).toBe(0);
  expect(result.inputs).toBeLessThan(15);
  expect(result.replies).toBe(1);
  expect(result.broadcasts).toBe(0);
});

test('crossing a neighbouring cell keeps retained chunk objects and builds only the three new visuals', async ({ page }) => {
  await ready(page);
  await expect.poll(() => page.evaluate(() => Number(window.chrona.runtime.metrics.preparedChunks))).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => window.chrona.runtime.metrics.prefetchError)).toBe('');
  await page.evaluate(() => window.chrona.runtime.pause(true));
  const result = await page.evaluate(async () => {
    const r = window.chrona.runtime, previous = new Map(r.chunks.active), builds = window.chrona.overview().chunkBuilds;
    const traffic = (window as any).__roamingTraffic, frameStart = traffic.frames.length;
    await r.teleport(Math.sqrt(3) * r.config.chunkRadius, 0);
    const retained = [...r.chunks.active].filter(([key]) => previous.has(key));
    const capture = window.chrona.capture(); // explicit capture drains the small visual queue
    return { retained: retained.length, sameObjects: retained.every(([key, value]) => previous.get(key) === value),
      builds: window.chrona.overview().chunkBuilds - builds, frames: traffic.frames.slice(frameStart),
      cameraError: Math.abs(capture.observation.viewport!.cameraMatrix[12] + capture.observation.origin.x - capture.observation.camera.x) };
  });
  expect(result.retained).toBe(4);
  expect(result.sameObjects).toBe(true);
  expect(result.builds).toBe(3);
  expect(result.frames.some((frame: any) => frame.chunks === 3 && frame.removed === 3 && !frame.reset)).toBe(true);
  expect(result.frames.every((frame: any) => frame.chunks <= 3)).toBe(true);
  expect(result.cameraError).toBeLessThan(1e-6);
});

test('read-only viewers receive an initial world then follow chunk deltas and stop broadcasts after leaving', async ({ page, context }) => {
  await ready(page);
  await page.evaluate(async () => { await window.chrona.runtime.pause(true); await window.chrona.save(); });
  const id = await page.evaluate(() => window.chrona.runtime.id);
  const viewer = await context.newPage();
  await viewer.goto(`/?world=${id}`);
  await viewer.waitForFunction(() => window.chrona?.ready);
  expect(await viewer.evaluate(() => window.chrona.runtime.readOnly)).toBe(true);
  await page.evaluate(() => window.chrona.runtime.teleport(Math.sqrt(3) * window.chrona.runtime.config.chunkRadius, 0));
  const keys = await page.evaluate(() => [...window.chrona.runtime.chunks.active.keys()].sort());
  await expect.poll(() => viewer.evaluate(() => [...window.chrona.runtime.chunks.active.keys()].sort())).toEqual(keys);
  await expect.poll(() => viewer.evaluate(() => window.chrona.overview().pendingVisuals)).toBe(0);
  await viewer.evaluate(() => window.chrona.runtime.dispose());
  const count = await page.evaluate(() => (window as any).__roamingTraffic.broadcasts);
  const tick = await page.evaluate(() => (window as any).__roamingTraffic.frames.length);
  await expect.poll(() => page.evaluate(() => (window as any).__roamingTraffic.frames.length)).toBeGreaterThan(tick + 3);
  expect(await page.evaluate(() => (window as any).__roamingTraffic.broadcasts)).toBe(count);
  await viewer.close();
});

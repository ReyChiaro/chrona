import { expect, type Page } from '@playwright/test';

/** Check the visible media bounds, including the area used by native video controls. */
export async function expectUnobscuredViews(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const issues: string[] = [];
    for (const panel of document.querySelectorAll<HTMLElement>('.view-panel')) {
      const label = panel.getAttribute('aria-label');
      const bounds = panel.getBoundingClientRect();
      const heading = panel.querySelector<HTMLElement>('.panel-heading')!;
      const stage = panel.querySelector<HTMLElement>('.stage')!.getBoundingClientRect();
      if (stage.height < 80) issues.push(`${label}: media too short`);
      if (stage.bottom > bounds.bottom + 1 || Math.abs(stage.bottom - bounds.bottom) > 2) issues.push(`${label}: media does not fill panel`);
      if (heading.scrollWidth > heading.clientWidth) issues.push(`${label}: heading overflows`);
      const parts = [...heading.children].map(part => part.getBoundingClientRect());
      if (parts[0].right > parts[1].left + 1 && parts[0].bottom > parts[1].top + 1) issues.push(`${label}: heading controls overlap`);
      for (const element of panel.querySelectorAll<HTMLVideoElement>('video:not([hidden])')) {
        const video = element.getBoundingClientRect();
        if (video.bottom > bounds.bottom + 1 || video.top < stage.top - 1) issues.push(`${label}: video controls are clipped`);
      }
    }
    if (document.documentElement.scrollWidth > innerWidth) issues.push('page overflows horizontally');
    return issues;
  })).toEqual([]);
}

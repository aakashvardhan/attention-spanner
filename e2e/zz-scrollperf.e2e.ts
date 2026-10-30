import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, it } from 'vitest';
import { PAGES, launch, seed, type Ext } from './harness';

// Throwaway benchmark: trackpad-style flicks over a real PDF.
let ext: Ext;
beforeAll(async () => {
  ext = await launch();
  const pdf = readFileSync(process.env.PDF!);
  ext.sites.setRoute('papers', '/p.pdf', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(pdf);
  });
  await seed(ext, { settings: { ollamaUrl: '', layaUrl: '', cloudMode: 'off' } });
});
afterAll(async () => ext?.close());

it('scroll perf', async () => {
  const page = await ext.page(`${PAGES.reader}?src=${encodeURIComponent(`${ext.sites.origin('papers')}/p.pdf`)}`);
  await page.waitForSelector('.reader-canvas[data-ready]');
  await page.waitForTimeout(1500);
  const box = (await page.locator('.reader-viewport').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const w = window as unknown as { perf: { gaps: number[]; blank: number } };
    w.perf = { gaps: [], blank: 0 };
    const vp = document.querySelector('.reader-viewport')!;
    let last = performance.now();
    const tick = (t: number) => {
      const vr = vp.getBoundingClientRect();
      for (const pg of vp.querySelectorAll('.reader-page')) {
        const r = pg.getBoundingClientRect();
        if (r.bottom > vr.top && r.top < vr.bottom && !pg.querySelector('.reader-canvas[data-ready]')) {
          w.perf.blank++;
          break;
        }
      }
      w.perf.gaps.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Momentum flicks: 8ms wheel events, each a fraction smaller (macOS inertia).
  for (let f = 0; f < 4; f++) {
    for (let v = Number(process.env.V0); v > 2; v *= Number(process.env.DECAY)) {
      await page.mouse.wheel(0, v);
      await page.waitForTimeout(8);
    }
  }
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const p = (window as unknown as { perf: { gaps: number[]; blank: number } }).perf;
    const g = p.gaps.slice(1).sort((a, b) => a - b);
    return {
      frames: g.length,
      blankFrames: p.blank,
      p95: g[Math.floor(g.length * 0.95)].toFixed(1),
      over33: g.filter((x) => x > 33).length,
      scrollTop: Math.round(document.querySelector('.reader-viewport')!.scrollTop),
    };
  });
  console.log('SCROLLPERF', JSON.stringify(r));
});

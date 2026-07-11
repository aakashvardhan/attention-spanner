/**
 * Records the LinkedIn demo of the Reader extension.
 *
 * Launches system Chrome (channel) with the built extension in a throwaway
 * profile, seeds realistic data (demo/seed.mjs), drives the storyboard's
 * 90-second cut with a fake cursor + burned-in captions (demo/overlay.js),
 * and captures per-page webm clips via Playwright's recordVideo.
 *
 * Emits demo/out/manifest.json describing, for every scene, which video file
 * it lives in and which [in, out] sub-segments to keep — demo/stitch.mjs
 * turns that into the final MP4.
 *
 *   node demo/record.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildSeed } from './seed.mjs';

const DEMO = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DEMO);
const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(DEMO, '.profile');
const OUT = path.join(DEMO, 'out');
const RAW = path.join(OUT, 'raw');
const NEWTAB_PATH = 'src/pages/newtab/index.html';
const CAPTURE_PATH = 'src/pages/capture/index.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileUrl = (p) => `file://${p}`;

/** Scene manifest, consumed by stitch.mjs */
const scenes = [];

function log(msg) {
  console.log(`[demo] ${msg}`);
}

function prepareProfile() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(RAW, { recursive: true, force: true });
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  // Gemini Nano in a fresh profile needs three things from the real one:
  // the model component, the adaptation store, and the Local State prefs
  // that register them (validated version, device performance class).
  // APFS copy-on-write clones (cp -c) make the 4GB copy instant.
  const realChrome = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
  const nano = path.join(realChrome, 'OptGuideOnDeviceModel');
  if (fs.existsSync(nano)) {
    execFileSync('cp', ['-Rc', nano, path.join(PROFILE, 'OptGuideOnDeviceModel')]);
    const store = path.join(realChrome, 'optimization_guide_model_store');
    if (fs.existsSync(store)) {
      execFileSync('cp', ['-Rc', store, path.join(PROFILE, 'optimization_guide_model_store')]);
    }
    const localState = JSON.parse(fs.readFileSync(path.join(realChrome, 'Local State'), 'utf8'));
    if (localState.optimization_guide) {
      fs.writeFileSync(
        path.join(PROFILE, 'Local State'),
        JSON.stringify({ optimization_guide: localState.optimization_guide }),
      );
    }
    log('Gemini Nano component + model store + prefs cloned into demo profile');
  } else {
    log('WARNING: no OptGuideOnDeviceModel found — brain-dump scene will be dropped');
  }
}

/** Wall-clock scene timer: seconds since the scene's page was created */
function clockFor() {
  const t0 = Date.now();
  return () => (Date.now() - t0) / 1000;
}

async function demoCall(page, fn, ...args) {
  return page.evaluate(
    ([f, a]) => window.__demo?.[f](...a),
    [fn, args],
  );
}

async function cursorClick(page, locator, moveMs = 650) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('cursorClick: element has no box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.evaluate(([cx, cy, ms]) => window.__demo.cursorTo(cx, cy, ms), [x, y, moveMs]);
  await sleep(150);
  await demoCall(page, 'clickPulse');
  await sleep(220);
  await locator.click();
}

async function smoothScroll(page, top, ms = 1600) {
  await page.evaluate(
    ([t, d]) =>
      new Promise((resolve) => {
        const from = window.scrollY;
        const start = performance.now();
        const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
        const step = (now) => {
          const k = Math.min(1, (now - start) / d);
          window.scrollTo(0, from + (t - from) * ease(k));
          if (k < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      }),
    [top, ms],
  );
}

async function finishScene(name, page, clock, segments, extra = {}) {
  const video = page.video();
  await page.close();
  const file = await video.path();
  scenes.push({ name, file: path.basename(file), segments, ...extra });
  log(`scene "${name}" → ${path.basename(file)} segments=${JSON.stringify(segments)}`);
}

async function main() {
  prepareProfile();

  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    recordVideo: { dir: RAW, size: { width: 1920, height: 1080 } },
    // Playwright disables the extension subsystem by default
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      // Chrome 137+ removed --load-extension; unpacked extensions are loaded
      // over CDP (Extensions.loadUnpacked), which needs this flag.
      '--enable-unsafe-extension-debugging',
      '--hide-crash-restore-bubble',
      '--window-size=1400,900',
      '--window-position=40,40',
    ],
  });
  context.setDefaultTimeout(20000);
  await context.addInitScript({ path: path.join(DEMO, 'overlay.js') });

  try {
    /* ---------- Setup: load extension, control page, seed, Nano ---------- */
    const cdp = await context.browser().newBrowserCDPSession();
    const { id: extensionId } = await cdp.send('Extensions.loadUnpacked', { path: DIST });
    log(`extension ${extensionId}`);
    await sleep(2500); // let onInstalled (migrate, alarms) settle before seeding

    // All chrome.* control calls go through a pinned extension page — the MV3
    // service worker can idle out between scenes, extension pages can't.
    const control = await context.newPage();
    await control.goto(`chrome-extension://${extensionId}/${NEWTAB_PATH}`);
    await control.evaluate((seed) => chrome.storage.local.set(seed), buildSeed());
    log('storage seeded');

    const nano = await control.evaluate(async () =>
      typeof LanguageModel === 'undefined' ? 'no-api' : await LanguageModel.availability(),
    );
    log(`Gemini Nano availability: ${nano}`);
    const nanoLive = nano === 'available';

    /* ---------- Scene 1: hook card (~7s) ---------- */
    {
      const page = await context.newPage();
      const clock = clockFor();
      await page.goto(fileUrl(path.join(DEMO, 'cards/hook.html')));
      await demoCall(page, 'hideCursor');
      const inAt = clock();
      await sleep(6800);
      await finishScene('hook', page, clock, [[inAt + 0.15, clock()]]);
    }

    /* ---------- Scene 2: quick capture (~13s) ---------- */
    {
      const page = await context.newPage();
      const clock = clockFor();
      await page.goto(fileUrl(path.join(DEMO, 'article.html')));
      await demoCall(page, 'hideCursor');
      const inAt = clock() + 0.2;
      await demoCall(page, 'setCaption', 'Reading something, thought strikes —\n⌘⇧Y captures it before it evaporates.');
      await sleep(1400);
      await smoothScroll(page, 640, 1800);
      await sleep(900);

      const popupPromise = context.waitForEvent('page');
      await control.evaluate((url) =>
        chrome.windows.create({ url, type: 'popup', focused: true, width: 440, height: 180 }),
        `chrome-extension://${extensionId}/${CAPTURE_PATH}`,
      );
      const popupOpenAt = clock();
      const popup = await popupPromise;
      const popClock = clockFor();
      await popup.setViewportSize({ width: 440, height: 180 });
      const input = popup.locator('input[type="text"]');
      await input.waitFor();
      await sleep(700);
      const popInAt = popClock();
      await input.pressSequentially('Reply to Sarah about the grant email', { delay: 52 });
      await sleep(500);
      await input.press('Enter');
      await popup.waitForEvent('close', { timeout: 5000 }).catch(() => {});
      const popVideo = popup.video();
      const popFile = await popVideo.path();
      scenes.push({
        name: 'capture-popup',
        file: path.basename(popFile),
        segments: [[popInAt, popClock()]],
        popup: true,
      });
      log(`scene "capture-popup" → ${path.basename(popFile)}`);

      await finishScene('capture-article', page, clock, [[inAt, popupOpenAt + 0.25]]);
      // Reorder: article context first, then the popup zoom-in
      const pop = scenes.pop();
      const art = scenes.pop();
      scenes.push(art, pop);
    }

    /* ---------- Scene 3: dashboard pan (~14s) ---------- */
    {
      const page = await context.newPage();
      const clock = clockFor();
      await page.goto(`chrome-extension://${extensionId}/${NEWTAB_PATH}`);
      await demoCall(page, 'hideCursor');
      await page.locator('.act-grid').waitFor();
      await sleep(600);
      const inAt = clock();
      await demoCall(page, 'setCaption', 'Every habit on one dashboard —\nwith a GitHub-style year of your attention.');
      await sleep(3200);
      const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      await demoCall(page, 'setCaption', 'Tasks, half-read articles, streaks, gym,\nflashcards, papers — nothing lives in your head.');
      await smoothScroll(page, Math.min(720, maxScroll), 2600);
      await sleep(2100);
      await smoothScroll(page, maxScroll, 2600);
      await sleep(2300);
      await finishScene('dashboard', page, clock, [[inAt, clock()]]);
    }

    /* ---------- Scene 4: AI brain dump (~22s, live Gemini Nano) ---------- */
    if (nanoLive) {
      const page = await context.newPage();
      const clock = clockFor();
      await page.goto(`chrome-extension://${extensionId}/${NEWTAB_PATH}`);
      await page.locator('.act-grid').waitFor();
      const dump = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Brain dump' }) });
      const textarea = dump.locator('textarea.bd-input');
      await textarea.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await sleep(700);
      const inAt = clock();
      await demoCall(page, 'setCaption', 'Racing thoughts? Dump them, unfiltered.');
      await demoCall(page, 'showCursor');
      await cursorClick(page, textarea);
      await textarea.pressSequentially(
        'email prof lin the study results, buy protein powder, the react state bug from yesterday is still open, book flights home for thanksgiving',
        { delay: 26 },
      );
      await sleep(700);
      const structureBtn = dump.locator('button.bd-primary', { hasText: 'Structure' });
      await cursorClick(page, structureBtn);
      const structAt = clock();
      await demoCall(page, 'hideCursor');
      await demoCall(page, 'setCaption', "Chrome's built-in Gemini Nano structures it —\non-device. No API key. Nothing leaves the machine.");
      await dump.locator('.bd-bullets li, .bd-proposed').first().waitFor({ timeout: 90000 });
      const resultAt = clock();
      await sleep(3600);
      await demoCall(page, 'showCursor');
      const addBtn = dump.locator('.bd-actions .bd-primary');
      await demoCall(page, 'setCaption', 'Bullets to keep — tasks straight into the list.');
      await cursorClick(page, addBtn);
      await sleep(1700);
      // Keep: typing + click (to 2s into the spinner), then cut to results
      const segments =
        resultAt - structAt > 4.5
          ? [[inAt, structAt + 2.0], [resultAt - 0.4, clock()]]
          : [[inAt, clock()]];
      await finishScene('braindump', page, clock, segments);
    } else {
      log('SKIPPING brain-dump scene — Gemini Nano not available in demo profile');
    }

    /* ---------- Scene 5: gamification (~15s) ---------- */
    {
      const page = await context.newPage();
      const clock = clockFor();
      await page.goto(`chrome-extension://${extensionId}/${NEWTAB_PATH}`);
      await page.locator('.act-grid').waitFor();
      const gym = page.locator('section.panel', { has: page.locator('h2', { hasText: '💪 Gym' }) });
      const progress = page.locator('section.panel', { has: page.locator('h2', { hasText: '🏆 Progress' }) });
      await gym.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await sleep(700);
      const inAt = clock();
      await demoCall(page, 'setCaption', 'Reading, focus, gym, flashcards — one XP pool.');
      await demoCall(page, 'showCursor');
      await sleep(1600);
      await cursorClick(page, gym.locator('button.sprint-start'));
      await sleep(900);
      await demoCall(page, 'setCaption', 'That check-in finished the weekly quest (+50 XP),\nhit week 8 of the streak — and unlocked a badge.');
      const questDone = progress.locator('.quest-done');
      await questDone.waitFor({ timeout: 5000 }).catch(() => log('quest-done line not visible!'));
      const badge = progress.locator('.badge-tile.unlocked', { hasText: 'Iron Habit' });
      await badge.waitFor({ timeout: 5000 }).catch(() => log('Iron Habit badge not visible!'));
      const box = await badge.boundingBox().catch(() => null);
      if (box) {
        await page.evaluate(([x, y]) => window.__demo.cursorTo(x, y, 900), [box.x + box.width / 2, box.y + box.height / 2]);
        await demoCall(page, 'clickPulse');
      }
      await sleep(4200);
      await finishScene('gamification', page, clock, [[inAt, clock()]]);
    }

    /* ---------- Scene 6: close card (~8s) ---------- */
    {
      const page = await context.newPage();
      const clock = clockFor();
      await page.goto(fileUrl(path.join(DEMO, 'cards/close.html')));
      await demoCall(page, 'hideCursor');
      const inAt = clock();
      await sleep(7200);
      await finishScene('close', page, clock, [[inAt + 0.15, clock()]]);
    }

    fs.writeFileSync(
      path.join(OUT, 'manifest.json'),
      JSON.stringify({ recordedAt: new Date().toISOString(), nano, scenes }, null, 2),
    );
    log(`manifest written — ${scenes.length} scene clips`);
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

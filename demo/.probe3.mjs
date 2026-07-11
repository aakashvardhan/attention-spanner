import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEMO = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(path.dirname(DEMO), 'dist');
const PROFILE = path.join(DEMO, '.profile-probe');
const HEADLESS = process.argv[2] === 'headless';
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });
const real = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
execFileSync('cp', ['-Rc', path.join(real, 'OptGuideOnDeviceModel'), path.join(PROFILE, 'OptGuideOnDeviceModel')]);
execFileSync('cp', ['-Rc', path.join(real, 'optimization_guide_model_store'), path.join(PROFILE, 'optimization_guide_model_store')]);
const ls = JSON.parse(fs.readFileSync(path.join(real, 'Local State'), 'utf8'));
delete ls.profile; fs.writeFileSync(path.join(PROFILE, 'Local State'), JSON.stringify(ls));

const context = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome',
  headless: HEADLESS,
  viewport: { width: 1920, height: 1080 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging', '--hide-crash-restore-bubble', '--disable-features=DialMediaRouteProvider,GlobalMediaControls,MediaRouter,Translate,PaintHolding'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: DIST });
  const page = await context.newPage();
  await sleep(1500);
  await page.goto(`chrome-extension://${id}/src/pages/newtab/index.html`);
  console.log('viewport innerSize:', await page.evaluate(() => `${innerWidth}x${innerHeight}`));
  for (let i = 0; i < 10; i++) {
    const a = await page.evaluate(async () => typeof LanguageModel === 'undefined' ? 'no-api' : await LanguageModel.availability());
    console.log(`t+${i * 4}s availability: ${a}`);
    if (a === 'available') break;
    await sleep(4000);
  }
  const created = await page.evaluate(async () => {
    try { const s = await LanguageModel.create(); return 'created session ok'; }
    catch (e) { return 'create error: ' + e.name + ' ' + e.message; }
  });
  console.log(created);
  try {
    const internals = await context.newPage();
    await internals.goto('chrome://version', { timeout: 8000 });
    await sleep(1500);
    const text = await internals.evaluate(() => document.getElementById('command_line').innerText);
    console.log('--- on-device-internals ---\n' + text);
  } catch (e) { console.log('internals: ' + e.message.split('\n')[0]); }
} finally {
  await context.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

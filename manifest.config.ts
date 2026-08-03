import { defineManifest } from '@crxjs/vite-plugin';
import { loadEnv } from 'vite';

// The reading tracker is injected dynamically via chrome.scripting (no static
// content_scripts); it's bundled separately by `npm run build:content`.
//
// Nothing here is OAuth-aware. Google Calendar signs in with the user's own
// client id and secret, entered in Settings and driven through
// launchWebAuthFlow (docs/google-calendar-setup.md) — no manifest `oauth2`
// block, and no build that has to know a client id. `key` stays optional: set
// VITE_CRX_PUBLIC_KEY to pin the extension id (and with it the OAuth redirect
// URL) across reloads from different paths.
export default defineManifest(async (env) => {
  const vars = loadEnv(env.mode, process.cwd(), '');
  const crxKey = (vars.VITE_CRX_PUBLIC_KEY ?? '').trim();

  return {
    manifest_version: 3,
    name: 'Reader',
    description:
      'RSS reader built for attention-challenged brains: finish what you start, capture tasks before they vanish.',
    version: '1.0.0',
    ...(crxKey ? { key: crxKey } : {}),
    icons: {
      '16': 'icons/icon-16.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
    // No default_popup: clicking the icon opens the side panel instead, wired
    // up with sidePanel.setPanelBehavior in the service worker. A popup is a
    // transient overlay that dies the moment you click the page behind it,
    // which is the wrong shape for a panel you keep open beside what you read.
    action: {
      default_icon: {
        '16': 'icons/icon-16.png',
        '48': 'icons/icon-48.png',
        '128': 'icons/icon-128.png',
      },
    },
    options_page: 'src/pages/options/index.html',
    chrome_url_overrides: {
      newtab: 'src/pages/newtab/index.html',
    },
    // The extension's main surface: beside the page you're on, rather than over
    // it. Opened by clicking the toolbar icon, or from the toggle-copilot
    // command; sidePanel.open needs a user gesture and a commands handler
    // counts as one.
    side_panel: {
      default_path: 'src/pages/sidepanel/index.html',
    },
    background: {
      service_worker: 'src/background/index.ts',
      type: 'module',
    },
    permissions: [
      'storage',
      'alarms',
      'notifications',
      'scripting',
      'declarativeNetRequest',
      // Read-only: response headers, to spot PDFs served from extensionless URLs
      'webRequest',
      'contextMenus',
      'identity',
      'offscreen',
      // Audio capture from a tab (meetings, videos) for transcription
      'tabCapture',
      // Transcripts are the largest records here — an hour of speech is ~60KB of
      // text, which does not fit alongside feeds/cards/papers in the 10MB default
      'unlimitedStorage',
      // The live copilot docks beside the tab you're in a meeting on
      'sidePanel',
      // Spoken replies on the wake-word path: the offscreen document cannot use
      // speechSynthesis (no user activation, so the autoplay policy blocks it),
      // so the worker speaks on its behalf
      'tts',
    ],
    host_permissions: ['<all_urls>'],
    // The on-device wake word runs three ONNX models through onnxruntime-web.
    // MV3's default policy has no wasm-unsafe-eval, so WebAssembly.instantiate
    // throws and the detector cannot load at all. 'self' is unchanged: this
    // adds the ability to run our own bundled WASM, not to fetch any remotely —
    // MV3 forbids remote code regardless, which is why dist/ort/ is copied in
    // at build time (scripts/copy-ort.mjs).
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    web_accessible_resources: [
      {
        // DNR redirects to an extension page require it to be web-accessible
        resources: [
          'src/pages/blocked/index.html',
          'src/pages/daily-gate/index.html',
        ],
        matches: ['http://*/*', 'https://*/*'],
      },
      {
        // The floating overlay is this page in an iframe, so the page has to be
        // loadable from a web origin.
        //
        // Only the document is listed. web_accessible_resources gates loads
        // *initiated by* a web origin — the host page starts the iframe, but
        // the chunks and fonts inside it are then fetched by the overlay
        // document itself, which is already on the extension origin. Listing
        // assets/* as well would publish every built chunk to every site, and
        // with it a reliable "is this extension installed" probe.
        resources: ['src/pages/overlay/index.html'],
        matches: ['http://*/*', 'https://*/*'],
      },
    ],
    commands: {
      'quick-capture-task': {
        suggested_key: {
          default: 'Ctrl+Shift+Y',
          mac: 'Command+Shift+Y',
        },
        description: 'Quick-capture a task',
      },
      // Not Shift+J, which is devtools on Windows and Linux.
      'toggle-copilot': {
        suggested_key: {
          default: 'Ctrl+Shift+K',
          mac: 'Command+Shift+K',
        },
        description: 'Open Jarvis beside this page',
      },
      'toggle-overlay': {
        suggested_key: {
          default: 'Ctrl+Shift+O',
          mac: 'Command+Shift+O',
        },
        description: 'Float Jarvis over this page',
      },
    },
  };
});

import { defineManifest } from '@crxjs/vite-plugin';
import { loadEnv } from 'vite';

// `key` stays optional: set VITE_CRX_PUBLIC_KEY to pin the extension id across
// reloads from different paths.
export default defineManifest(async (env) => {
  const vars = loadEnv(env.mode, process.cwd(), '');
  const crxKey = (vars.VITE_CRX_PUBLIC_KEY ?? '').trim();

  return {
    manifest_version: 3,
    name: 'Reader',
    description:
      'A quiet companion to alphaXiv: a paper shelf, and a reader that asks instead of tells and blocks what pulls you away.',
    version: '1.0.0',
    ...(crxKey ? { key: crxKey } : {}),
    icons: {
      '16': 'icons/icon-16.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
    // No default_popup: clicking the icon opens the new tab, wired up with
    // action.onClicked in the service worker. A popup is a transient overlay
    // that dies the moment you click the page behind it, which is the wrong
    // shape for anything you want to keep looking at while you work.
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
    background: {
      service_worker: 'src/background/index.ts',
      type: 'module',
    },
    // identity: alphaXiv's login window (chrome.identity.launchWebAuthFlow)
    permissions: ['storage', 'alarms', 'declarativeNetRequest', 'identity'],
    // Any blocklisted site can be redirected while you read, so the redirect
    // rules need every host; api.alphaxiv.org is reached from the worker.
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      // wasm-unsafe-eval lets pdf.js compile its image decoders (vite.config.ts)
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    web_accessible_resources: [
      {
        // DNR redirects to an extension page require it to be web-accessible
        resources: ['src/pages/blocked/index.html', 'src/pages/reader/index.html'],
        matches: ['http://*/*', 'https://*/*'],
      },
    ],
  };
});

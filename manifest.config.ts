import { defineManifest } from '@crxjs/vite-plugin';
import { loadEnv } from 'vite';

// The reading tracker is injected dynamically via chrome.scripting (no static
// content_scripts); it's bundled separately by `npm run build:content`.
//
// `key` stays optional: set VITE_CRX_PUBLIC_KEY to pin the extension id across
// reloads from different paths.
export default defineManifest(async (env) => {
  const vars = loadEnv(env.mode, process.cwd(), '');
  const crxKey = (vars.VITE_CRX_PUBLIC_KEY ?? '').trim();

  return {
    manifest_version: 3,
    name: 'Reader',
    description:
      'An RSS reader and document reader that tracks what you start, brings you back to it, and blocks what pulls you away.',
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
    // Acts on the page you're on, beside it rather than over it. Opened by
    // clicking the toolbar icon (sidePanel.setPanelBehavior in the worker).
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
      'sidePanel',
    ],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self'",
    },
    web_accessible_resources: [
      {
        // DNR redirects to an extension page require it to be web-accessible
        resources: ['src/pages/blocked/index.html'],
        matches: ['http://*/*', 'https://*/*'],
      },
    ],
    commands: {
      // Shift+E is unclaimed in both Chrome and Brave; on an update the key
      // only binds if the user has not customised their shortcuts, so it is
      // worth checking chrome://extensions/shortcuts after installing.
      'read-this-page': {
        suggested_key: {
          default: 'Ctrl+Shift+E',
          mac: 'Command+Shift+E',
        },
        description: 'Read this page in Reader',
      },
    },
  };
});

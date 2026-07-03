import { defineManifest } from '@crxjs/vite-plugin';

// The reading tracker is injected dynamically via chrome.scripting (no static
// content_scripts); it's bundled separately by `npm run build:content`.
export default defineManifest({
  manifest_version: 3,
  name: 'ADHD Reader',
  description:
    'RSS reader built for attention-challenged brains: finish what you start, capture tasks before they vanish.',
  version: '1.0.0',
  icons: {
    '16': 'icons/icon-16.png',
    '48': 'icons/icon-48.png',
    '128': 'icons/icon-128.png',
  },
  action: {
    default_popup: 'src/pages/popup/index.html',
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
  permissions: [
    'storage',
    'alarms',
    'notifications',
    'scripting',
    'declarativeNetRequest',
    'contextMenus',
  ],
  host_permissions: ['<all_urls>'],
  web_accessible_resources: [
    {
      // DNR redirects to an extension page require it to be web-accessible
      resources: ['src/pages/blocked/index.html'],
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
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    // Preload links on a chrome-extension:// origin never get claimed — Chrome
    // keys the preload differently from the module fetch and discards it. The
    // polyfill is dead weight too: Chrome has supported modulepreload natively
    // since 66, well below anything that can run an MV3 extension.
    modulePreload: false,
    rollupOptions: {
      // The capture window is opened via chrome.windows.create, not referenced
      // from the manifest, so it must be declared as an extra entry.
      input: {
        capture: 'src/pages/capture/index.html',
        blocked: 'src/pages/blocked/index.html',
        papers: 'src/pages/papers/index.html',
        jobs: 'src/pages/jobs/index.html',
        reader: 'src/pages/reader/index.html',
        offscreen: 'src/pages/offscreen/index.html',
        sidepanel: 'src/pages/sidepanel/index.html',
        overlay: 'src/pages/overlay/index.html',
      },
    },
  },
});

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
      // Pages the manifest does not name directly still need an entry.
      input: {
        blocked: 'src/pages/blocked/index.html',
        papers: 'src/pages/papers/index.html',
        reader: 'src/pages/reader/index.html',
      },
    },
  },
});

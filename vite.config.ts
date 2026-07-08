import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  build: {
    rollupOptions: {
      // The capture window is opened via chrome.windows.create, not referenced
      // from the manifest, so it must be declared as an extra entry.
      input: {
        capture: 'src/pages/capture/index.html',
        blocked: 'src/pages/blocked/index.html',
        flashcards: 'src/pages/flashcards/index.html',
        papers: 'src/pages/papers/index.html',
      },
    },
  },
});

import React from 'react';
import { createRoot } from 'react-dom/client';
import { GlobalWorkerOptions } from 'pdfjs-dist';
import { initTheme } from '../../shared/theme';
import { Reader } from './Reader';
import '../../shared/theme.css';
import './reader.css';

// pdf.js parses in a worker. new Worker(new URL(...)) is bundled by Vite into
// a same-origin chunk, which is what the extension-page CSP requires (no CDN).
GlobalWorkerOptions.workerPort = new Worker(
  new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url),
  { type: 'module' },
);

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Reader />
  </React.StrictMode>,
);

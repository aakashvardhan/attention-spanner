import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { Blocked } from './Blocked';
import '../../shared/theme.css';
import './blocked.css';

// blocked.css is written against the shared tokens (--font-sans, --space-*,
// --text-*, --radius-lg) but this page never imported them, so every one of
// them resolved to nothing and the block screen rendered in a fallback face.
// It is the one screen shown to someone mid-impulse; it should be the most
// legible in the product, not the least.
initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Blocked />
  </React.StrictMode>,
);

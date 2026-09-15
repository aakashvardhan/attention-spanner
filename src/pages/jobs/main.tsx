import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { Jobs } from './Jobs';
import '../../shared/theme.css';
import './jobs.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Jobs />
  </React.StrictMode>,
);

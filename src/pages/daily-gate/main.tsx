import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { DailyGatePage } from './DailyGatePage';
import '../../shared/theme.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DailyGatePage />
  </React.StrictMode>,
);

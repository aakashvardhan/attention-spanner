import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { Dashboard } from './Dashboard';
import '../../shared/theme.css';
import './newtab.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>,
);

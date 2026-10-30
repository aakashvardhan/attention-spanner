import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { Dumps } from './Dumps';
import '../../shared/theme.css';
import './dumps.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Dumps />
  </React.StrictMode>,
);

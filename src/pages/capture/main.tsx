import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { Capture } from './Capture';
import '../../shared/theme.css';
import './capture.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Capture />
  </React.StrictMode>,
);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { Papers } from './Papers';
import '../../shared/theme.css';
import './papers.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Papers />
  </React.StrictMode>,
);

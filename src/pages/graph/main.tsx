import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { Graph } from './Graph';
import '../../shared/theme.css';
import './graph.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Graph />
  </React.StrictMode>,
);

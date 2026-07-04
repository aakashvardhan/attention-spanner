import React from 'react';
import { createRoot } from 'react-dom/client';
import { Blocked } from './Blocked';
import './blocked.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Blocked />
  </React.StrictMode>,
);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Dumps } from './Dumps';
import '../../shared/theme.css';
import './dumps.css';


createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Dumps />
  </React.StrictMode>,
);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Papers } from './Papers';
import '../../shared/theme.css';
import './papers.css';


createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Papers />
  </React.StrictMode>,
);

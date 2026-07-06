import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { Flashcards } from './Flashcards';
import '../../shared/theme.css';
import './flashcards.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Flashcards />
  </React.StrictMode>,
);

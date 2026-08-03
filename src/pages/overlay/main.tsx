import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { LiveCopilot } from '../../shared/components/LiveCopilot';
import { useTheme } from '../../shared/hooks/useTheme';
import '../../shared/theme.css';
import './overlay.css';

/**
 * The floating overlay's contents. This is a normal extension page loaded into
 * an iframe by src/content/copilotOverlay.ts — which is the whole point of the
 * arrangement: inside the frame we get theme.css, the bundled font and the
 * extension's own CSP, none of which a content script can have. The content
 * script only positions the frame; everything visible is this page.
 */

initTheme();

function Overlay() {
  useTheme();
  return <LiveCopilot />;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>,
);

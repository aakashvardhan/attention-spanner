import React from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '../../shared/theme';
import { SidePanel } from './SidePanel';
import '../../shared/theme.css';
import './panel.css';

initTheme();

class SidePanelErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[sidePanel] render failed', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="panel-fatal" role="alert">
        <p className="panel-fatal-eyebrow">Reader side panel</p>
        <h1>Something interrupted this panel.</h1>
        <p>Your tasks and reading context are still saved.</p>
        <div>
          <button type="button" onClick={() => location.reload()}>Reload panel</button>
          <button type="button" onClick={() => void chrome.runtime.openOptionsPage()}>
            Open settings
          </button>
        </div>
      </main>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SidePanelErrorBoundary>
      <SidePanel />
    </SidePanelErrorBoundary>
  </React.StrictMode>,
);

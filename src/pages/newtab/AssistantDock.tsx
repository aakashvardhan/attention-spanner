import { useEffect, useRef, useState } from 'react';
import { AssistantChat } from '../../shared/components/AssistantChat';

/**
 * The dashboard's assistant, docked bottom-right and closed by default — the
 * grid is the page, and Jarvis is something you reach for. It shares the popup's
 * session thread, so a conversation started in one continues in the other.
 */
export function AssistantDock() {
  const [open, setOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  const close = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) requestAnimationFrame(() => toggleRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    // The toggle lives inside the dock, so its own click can't close-then-reopen
    const onDown = (e: MouseEvent) => {
      if (!dockRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div className="dock" ref={dockRef}>
      {open && (
        <section
          className="dock-panel"
          id="dashboard-assistant"
          role="dialog"
          aria-modal="false"
          aria-labelledby="dashboard-assistant-title"
          aria-describedby="dashboard-assistant-description"
        >
          <header className="dock-head">
            <div>
              <span className="dock-mark" aria-hidden="true">✦</span>
              <div>
                <h2 id="dashboard-assistant-title">Assistant</h2>
                <p id="dashboard-assistant-description">Your day, tasks, and library</p>
              </div>
            </div>
            <button
              type="button"
              className="dock-close"
              aria-label="Close assistant"
              onClick={() => close(true)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </header>
          <AssistantChat autoFocus surface="dashboard" />
        </section>
      )}
      {!open && (
        <button
          ref={toggleRef}
          type="button"
          className="dock-toggle"
          aria-controls="dashboard-assistant"
          aria-expanded={false}
          onClick={() => setOpen(true)}
        >
          <span className="dock-toggle-mark" aria-hidden="true">✦</span>
          Ask Assistant
        </button>
      )}
    </div>
  );
}

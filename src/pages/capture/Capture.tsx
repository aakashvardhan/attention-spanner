import { useEffect, useRef, useState } from 'react';
import { BrainDump } from '../../shared/components/BrainDump';
import { CAPTURE_WINDOW_DUMP, CAPTURE_WINDOW_TASK } from '../../shared/constants';
import { useTheme } from '../../shared/hooks/useTheme';
import { sendMessage } from '../../shared/messages';

type Mode = 'task' | 'dump';

/**
 * Quick-capture window (global shortcut). Task mode: type, Enter, gone.
 * Dump mode (⌘D): multi-line brain dump structured by on-device AI.
 */
export function Capture() {
  useTheme();
  const [mode, setMode] = useState<Mode>('task');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'task') inputRef.current?.focus();
    // Resize the window to fit the mode; no background round-trip needed
    void (async () => {
      const win = await chrome.windows.getCurrent();
      if (win.id !== undefined) {
        const size = mode === 'dump' ? CAPTURE_WINDOW_DUMP : CAPTURE_WINDOW_TASK;
        await chrome.windows.update(win.id, { width: size.width, height: size.height });
      }
    })();
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close();
      if (e.key === 'd' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setMode((m) => (m === 'task' ? 'dump' : 'task'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const submitTask = async () => {
    const trimmed = text.trim();
    if (!trimmed || saved) return;
    setSaved(true);
    await sendMessage({ type: 'ADD_TASK', text: trimmed, source: 'capture' });
    setTimeout(() => window.close(), 350);
  };

  return (
    <div className="capture">
      <div className="capture-modes">
        <button
          className={mode === 'task' ? 'mode-btn active' : 'mode-btn'}
          onClick={() => setMode('task')}
        >
          ✓ Task
        </button>
        <button
          className={mode === 'dump' ? 'mode-btn active' : 'mode-btn'}
          onClick={() => setMode('dump')}
        >
          🧠 Brain dump
        </button>
      </div>

      {mode === 'task' ? (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitTask();
            }}
          >
            <input
              ref={inputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What do you need to remember?"
              maxLength={300}
              disabled={saved}
            />
          </form>
          <p className="capture-hint">
            {saved ? '✓ Captured!' : 'Enter to save · ⌘D for brain dump · Esc to cancel'}
          </p>
        </>
      ) : (
        <>
          <BrainDump source="capture" onDone={() => setTimeout(() => window.close(), 200)} />
          <p className="capture-hint">⌘Enter to structure · ⌘D for task mode · Esc to close</p>
        </>
      )}
    </div>
  );
}

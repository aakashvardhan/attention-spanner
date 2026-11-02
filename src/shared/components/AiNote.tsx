import { lazy, Suspense } from 'react';
import type { AiView } from '../hooks/useAi';
import './aiNote.css';

// KaTeX and marked are ~300 KB. The new tab opens constantly and mostly shows
// no AI text at all, so the renderer loads with the first answer instead.
const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

/**
 * Every AI answer in the extension renders through this, so they all say the
 * same things the same way: what was written and which model wrote it. No sparkles; it sits inside the card it belongs to.
 */
export function AiNote({
  view,
  onStop,
  onRetry,
}: {
  view: AiView;
  onStop: () => void;
  onRetry?: () => void;
}) {
  if (view.status === 'idle') return null;

  if (view.status === 'unavailable') {
    return (
      <div className="ai-note ai-note--quiet">
        <p>
          {view.error}.{' '}
          <button type="button" className="ai-note-link" onClick={() => void chrome.runtime.openOptionsPage()}>
            Open Settings
          </button>
        </p>
      </div>
    );
  }

  const busy = view.status === 'working' || view.status === 'streaming';
  const { text } = view;

  return (
    <div className="ai-note" aria-live="polite" aria-busy={busy}>
      {view.status === 'working' && !view.text ? (
        <div className="ai-note-skeleton" aria-label="Writing">
          <span />
          <span />
        </div>
      ) : (
        <Suspense fallback={<p>{text}</p>}>
          <Markdown text={text} />
        </Suspense>
      )}

      {view.status === 'error' && (
        <p className="ai-note-error">
          {view.error}
          {onRetry && (
            <button type="button" className="ai-note-link" onClick={onRetry}>
              Try again
            </button>
          )}
        </p>
      )}

      <div className="ai-note-foot">
        {view.route && (
          <small className="ai-note-chip" title={view.route.reason}>
            {view.route.target === 'claude' ? modelLabel(view.model || view.route.model) : view.route.reason}
          </small>
        )}
        {busy && (
          <button type="button" className="ai-note-link" onClick={onStop}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

function modelLabel(model: string): string {
  if (model.startsWith('claude-haiku')) return 'Claude Haiku';
  if (model.startsWith('claude-sonnet')) return 'Claude Sonnet';
  return model;
}

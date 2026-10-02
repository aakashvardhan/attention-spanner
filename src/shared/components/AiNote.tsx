import { lazy, Suspense } from 'react';
import type { AiView } from '../hooks/useAi';
import './aiNote.css';

// KaTeX and marked are ~300 KB. The new tab opens constantly and mostly shows
// no AI text at all, so the renderer loads with the first answer instead.
const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

/**
 * Every AI answer in the extension renders through this, so they all say the
 * same three things the same way: what was written, where it ran and why, and
 * what it is based on. No sparkles; it sits inside the card it belongs to.
 */
export function AiNote({
  view,
  onStop,
  onApprove,
  onDismiss,
  onRetry,
  onCite,
}: {
  view: AiView;
  onStop: () => void;
  onApprove: () => void;
  onDismiss: () => void;
  onRetry?: () => void;
  /** Present = `[n]` markers become source buttons that jump to passage n-1 */
  onCite?: (index: number) => void;
}) {
  if (view.status === 'idle') return null;

  if (view.status === 'confirm' && view.route?.target === 'claude') {
    return (
      <div className="ai-note" role="group" aria-label="Send to cloud?">
        <p className="ai-note-ask">
          Send this public document to {modelLabel(view.route.model)}?
          <small>{view.route.reason}</small>
        </p>
        <div className="ai-note-actions">
          <button type="button" className="ai-note-btn ai-note-btn--primary" onClick={onApprove}>
            Send
          </button>
          <button type="button" className="ai-note-btn" onClick={onDismiss}>
            Not now
          </button>
        </div>
      </div>
    );
  }

  if (view.status === 'unavailable') {
    return (
      <div className="ai-note ai-note--quiet">
        <p>
          {view.error}.{' '}
          <button type="button" className="ai-note-link" onClick={() => void chrome.runtime.openOptionsPage()}>
            Set up local AI
          </button>
        </p>
      </div>
    );
  }

  const busy = view.status === 'working' || view.status === 'streaming';
  const { text, cited } = onCite ? verifyCitations(view.text, view.sent) : { text: view.text, cited: [] };

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

      {cited.length > 0 && (
        <p className="ai-note-sources">
          From
          {cited.map((n) => (
            <button key={n} type="button" className="ai-note-cite" onClick={() => onCite?.(n - 1)}>
              {n}
            </button>
          ))}
        </p>
      )}

      <div className="ai-note-foot">
        {view.route && (
          <small className="ai-note-chip" title={view.route.reason}>
            {view.route.target === 'claude'
              ? `${modelLabel(view.model || view.route.model)} · cloud`
              : `On device${view.model ? ` · ${view.model}` : ''}`}
            <span className="ai-note-why"> — {view.route.reason}</span>
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

/**
 * Keep only `[n]` markers that point at a passage the model was actually
 * shown; any other number is invented and is removed from the text. While the
 * passage set is unknown (a cached answer) nothing can be verified, so no
 * marker is offered as a link.
 */
export function verifyCitations(text: string, sent: number[]): { text: string; cited: number[] } {
  const allowed = new Set(sent.map((i) => i + 1));
  const cited = new Set<number>();
  const cleaned = text.replace(/\s?\[(\d{1,4})\]/g, (marker, digits: string) => {
    const n = Number(digits);
    if (!allowed.has(n)) return '';
    cited.add(n);
    return marker;
  });
  return { text: cleaned, cited: [...cited].sort((a, b) => a - b) };
}

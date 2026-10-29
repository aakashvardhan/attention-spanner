import { useEffect, useRef, useState } from 'react';
import { AiNote } from '../../../shared/components/AiNote';
import { SaveNotePrompt } from '../../../shared/components/SaveNotePrompt';
import { useAi } from '../../../shared/hooks/useAi';
import type { AiSource } from '../../../shared/llm/route';
import { defineRequest } from '../../../shared/llm/terms';

export interface DefineTarget {
  word: string;
  context: string;
  near: string;
  /** Viewport coordinates of the word; the popover opens below it when `flip` */
  x: number;
  y: number;
  flip: boolean;
}

/**
 * A clicked term, guessed first: the reader says what they think it means from
 * the sentence around it, then compares with the paper's meaning, streamed in
 * next to it. Closes on any click outside.
 */
export function DefinePopover({
  target,
  docKey,
  source,
  onClose,
  onSave,
}: {
  target: DefineTarget;
  docKey: string;
  source: AiSource;
  onClose: () => void;
  /** Present = once written, ask whether to keep the definition as a note on the term */
  onSave?: (definition: string) => void;
}) {
  const ai = useAi();
  const { start } = ai;
  const { word, context, near, x, y, flip } = target;
  const [draft, setDraft] = useState('');
  const [guess, setGuess] = useState<string | null>(null);
  useEffect(() => {
    if (guess !== null) void start(defineRequest({ key: docKey, word, context, near, source }));
  }, [start, guess, docKey, word, context, near, source]);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="cite-tooltip define-popover"
      role="dialog"
      aria-label={`Definition of ${word}`}
      style={{
        left: x,
        top: y,
        transform: flip ? 'translate(-50%, 0)' : undefined,
        maxHeight: (flip ? window.innerHeight - y : y) - 12,
      }}
    >
      {guess === null ? (
        <form
          className="define-guess"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) setGuess(draft.trim());
          }}
        >
          <label className="define-guess-question" htmlFor="define-guess-input">
            From the sentence around it, what do you think “{word}” means here?
          </label>
          <input
            id="define-guess-input"
            className="provoke-answer"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="fc-primary-btn" disabled={!draft.trim()}>
            Compare
          </button>
        </form>
      ) : (
        <>
          <p className="define-label">Your guess</p>
          <p className="define-guess-text">{guess}</p>
          <p className="define-label">In the paper</p>
          <AiNote view={ai.view} onStop={ai.stop} onApprove={ai.approve} onDismiss={onClose} />
          {onSave && (
            <SaveNotePrompt
              view={ai.view}
              onSave={(note) => {
                onSave(`Your guess: ${guess} / Paper: ${note}`);
                onClose();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

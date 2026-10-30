import { useState } from 'react';
import type { AiView } from '../hooks/useAi';

/**
 * Under a finished definition: keep it as a note on the term, or not. Declining
 * only hides the question; the definition stays up.
 */
export function SaveNotePrompt({ view, onSave }: { view: AiView; onSave: (note: string) => void }) {
  const [declined, setDeclined] = useState(false);
  if (declined || view.status !== 'done' || !view.text) return null;
  return (
    <div className="ai-note-actions" role="group" aria-label="Save as a note">
      <span>Save as a note here?</span>
      <button
        type="button"
        className="ai-note-btn ai-note-btn--primary"
        // Notes are plain text, so the definition's bold markers would show as asterisks.
        onClick={() => onSave(view.text.replace(/\*\*/g, ''))}
      >
        Save note
      </button>
      <button type="button" className="ai-note-btn" onClick={() => setDeclined(true)}>
        No
      </button>
    </div>
  );
}

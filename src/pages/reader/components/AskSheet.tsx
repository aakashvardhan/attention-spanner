import { useEffect, useRef, useState } from 'react';
import { AiNote, verifyCitations } from '../../../shared/components/AiNote';
import { useAi } from '../../../shared/hooks/useAi';
import type { AiSource } from '../../../shared/llm/route';
import { recordStat } from '../../../shared/llm/store';

export const ASK_SYSTEM =
  'You answer questions about one document for a reader who has ADHD. Use only the numbered ' +
  'passages given. After each claim, cite the passage it comes from as [n], using the number ' +
  "the passage is labelled with. If the passages do not answer the question, say exactly: I couldn't " +
  'find that in this document. Lead with the answer, then at most a few short bullets. Markdown, ' +
  'with LaTeX for math ($…$). No preamble, no emoji.';

/**
 * Questions answered from the document on screen, with every claim pointing
 * back at the passage it came from. A citation number the model was never
 * shown is dropped before rendering (AiNote.verifyCitations), so a source
 * button always lands on real text.
 */
export function AskSheet({
  passages,
  source,
  passageNoun,
  onJump,
  onClose,
}: {
  /** Pages for a PDF, blocks for an article; null while the text loads */
  passages: string[] | null;
  source: AiSource;
  passageNoun: 'page' | 'passage';
  onJump: (index: number) => void;
  onClose: () => void;
}) {
  const ai = useAi();
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const counted = useRef('');

  const ask = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || !passages) return;
    setAsked(trimmed);
    void ai.start({
      task: 'ask',
      source,
      system: ASK_SYSTEM,
      passages,
      numbered: true,
      prompt: `Question: ${trimmed}`,
    });
  };

  // Count each finished answer once, and whether it could be traced to a source.
  const { status, text, sent } = ai.view;
  useEffect(() => {
    if (status !== 'done' || counted.current === text) return;
    counted.current = text;
    void recordStat({ count: 'ask.answered' });
    if (verifyCitations(text, sent).cited.length > 0) void recordStat({ count: 'ask.cited' });
  }, [status, text, sent]);

  return (
    <aside className="reader-find reader-ask" aria-label="Ask this document">
      <div className="reader-related-head">
        <h2>Ask this document</h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close questions">
          ✕
        </button>
      </div>
      <form
        className="reader-ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
          setQuestion('');
        }}
      >
        <input
          className="reader-find-input"
          autoFocus
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={passages ? 'What is the main result?' : 'Reading the text…'}
          disabled={!passages}
          aria-label="Your question"
        />
      </form>
      {asked && <p className="reader-ask-question">{asked}</p>}
      <AiNote
        view={ai.view}
        onStop={ai.stop}
        onApprove={ai.approve}
        onDismiss={ai.dismiss}
        onRetry={() => ask(asked)}
        onCite={onJump}
      />
      {status === 'idle' && passages && (
        <p className="reader-notes-empty">
          Answers come from this document only, and each one links to the {passageNoun} it is
          based on.
        </p>
      )}
    </aside>
  );
}

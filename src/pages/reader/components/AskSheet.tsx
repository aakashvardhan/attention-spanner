import { useEffect, useRef, useState } from 'react';
import { AiNote } from '../../../shared/components/AiNote';
import { useAi, type AiView } from '../../../shared/hooks/useAi';
import type { AiSource } from '../../../shared/llm/route';
import { MATH_RULE } from '../../../shared/llm/generate';
import { FALLBACK } from '../../../shared/llm/provoke';

export const ASK_SYSTEM =
  'You answer questions about one document for a reader who has ADHD. Use only the numbered ' +
  'passages given. After each claim, cite the passage it comes from as [n], using the number ' +
  "the passage is labelled with. If the passages do not answer the question, say exactly: I couldn't " +
  'find that in this document. Lead with the answer, then at most a few short bullets. Markdown. ' +
  'No preamble, no emoji.' + MATH_RULE + ' Earlier questions and answers may come ' +
  'before the question; use them to resolve follow-ups, but answer only the latest question.';

/** Earlier turns sent with a follow-up; older ones fall off so the prompt stays small. */
const HISTORY_TURNS = 6;

interface Turn {
  q: string;
  view: AiView;
}

/** The thread survives closing the sheet and reloading the tab, not the tab itself. */
const threadKey = () => `ask:${location.search}`;
function loadThread(): Turn[] {
  try {
    return JSON.parse(sessionStorage.getItem(threadKey()) ?? '[]') as Turn[];
  } catch {
    return [];
  }
}

/**
 * Questions answered from the document on screen, with every claim pointing
 * back at the passage it came from. A citation number the model was never
 * shown is dropped before rendering (AiNote.verifyCitations), so a source
 * button always lands on real text.
 *
 * With `thread={false}` (the PDF) it is "Question it": one question at a time,
 * nothing kept, and `system` (socraticSystem) points back at a page instead of
 * answering.
 */
export function AskSheet({
  passages,
  source,
  passageNoun,
  onJump,
  onClose,
  system = ASK_SYSTEM,
  thread = true,
}: {
  /** Pages for a PDF, blocks for an article; null while the text loads */
  passages: string[] | null;
  source: AiSource;
  passageNoun: 'page' | 'passage';
  onJump: (index: number) => void;
  onClose: () => void;
  system?: string;
  /** false = one question at a time, no history kept or sent */
  thread?: boolean;
}) {
  const heading = thread ? 'Ask this document' : 'Question it';
  const ai = useAi();
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState('');
  const [turns, setTurns] = useState<Turn[]>(() => (thread ? loadThread() : []));
  const countedView = useRef<AiView | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!thread) return;
    try {
      sessionStorage.setItem(threadKey(), JSON.stringify(turns));
    } catch {
      // Storage blocked: the thread just lasts as long as the sheet.
    }
  }, [turns, thread]);


  const ask = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed || !passages) return;
    setAsked(trimmed);
    const context = turns
      .slice(-HISTORY_TURNS)
      .map((t) => `Earlier question: ${t.q}\nEarlier answer: ${t.view.text}`)
      .join('\n\n');
    void ai.start({
      task: 'ask',
      source,
      system,
      passages,
      numbered: true,
      // ponytail: local retrieval embeds this whole prompt, history included;
      // embed only the question if follow-ups start pulling the wrong pages.
      prompt: context ? `${context}\n\nQuestion: ${trimmed}` : `Question: ${trimmed}`,
    });
  };

  const clear = () => {
    ai.dismiss();
    setAsked('');
    setTurns([]);
  };

  // File each finished answer into the thread once.
  const { view } = ai;
  const { status } = view;
  useEffect(() => {
    // By identity, not text: a follow-up can get the same words back.
    if (!thread || status !== 'done' || countedView.current === view) return;
    countedView.current = view;
    setTurns((t) => [...t, { q: asked, view }]);
  }, [status, asked, view, thread]);

  // Without a thread the latest reply stays up instead of being filed.
  const live = thread ? status !== 'done' && status !== 'idle' : status !== 'idle';
  // With no model, the guiding question is still one the reader can use.
  const fallback = !thread && (status === 'unavailable' || status === 'error');

  // Braces matter: Chrome's scrollIntoView now returns a Promise, which React would call as the cleanup.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [asked, turns, status]);

  return (
    <aside className="reader-find reader-ask" aria-label={heading}>
      <div className="reader-related-head">
        <h2>{heading}</h2>
        {turns.length > 0 && (
          <button className="ghost-btn reader-ask-new" onClick={clear}>
            New chat
          </button>
        )}
        <button className="ghost-btn" onClick={onClose} aria-label="Close questions">
          ✕
        </button>
      </div>
      {turns.map((t, i) => (
        <div key={i} className="reader-ask-turn">
          <p className="reader-ask-question">{t.q}</p>
          <AiNote view={t.view} onStop={noop} onApprove={noop} onDismiss={noop} onCite={onJump} />
        </div>
      ))}
      {fallback ? (
        <>
          <p className="reader-ask-question">{asked}</p>
          <p className="provoke-question">{FALLBACK.question}</p>
        </>
      ) : (
        live && (
          <>
            <p className="reader-ask-question">{asked}</p>
            <AiNote
              view={view}
              onStop={ai.stop}
              onApprove={ai.approve}
              onDismiss={ai.dismiss}
              onRetry={() => ask(asked)}
              onCite={onJump}
            />
          </>
        )
      )}
      {thread && status === 'idle' && !turns.length && passages && (
        <p className="reader-notes-empty">
          Answers come from this document only, and each one links to the {passageNoun} it is
          based on.
        </p>
      )}
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
          placeholder={
            !passages
              ? 'Reading the text…'
              : !thread
                ? 'What are you trying to figure out?'
                : turns.length
                  ? 'Ask a follow-up'
                  : 'What is the main result?'
          }
          disabled={!passages}
          aria-label="Your question"
        />
      </form>
      <div ref={endRef} />
    </aside>
  );
}

const noop = () => {};

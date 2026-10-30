import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { annotationDocKey, DEFAULT_ANNOTATION_COLOR } from '../../shared/annotations';
import { AiNote } from '../../shared/components/AiNote';
import { SaveNotePrompt } from '../../shared/components/SaveNotePrompt';
import { sendMessage } from '../../shared/messages';
import { useAi } from '../../shared/hooks/useAi';
import { sourceForUrl } from '../../shared/llm/route';
import { defineRequest } from '../../shared/llm/terms';
import { initTheme } from '../../shared/theme';
import '../../shared/theme.css';
import './define.css';

/*
 * The card behind Option/Alt-click on a web page (src/content/define.ts): the
 * same definition the PDF reader gives, routed by the page's URL like any other
 * web page, so it counts as private. It tells the page its height; the page
 * owns where it sits and when it closes.
 */

const params = new URLSearchParams(location.search);
const src = params.get('src') ?? '';
const word = params.get('word') ?? '';
const context = params.get('context') ?? '';
const near = params.get('near') ?? '';
const prefix = params.get('prefix') ?? '';
const suffix = params.get('suffix') ?? '';

const tell = (message: object) => window.parent.postMessage(message, '*');

function DefineCard() {
  const ai = useAi();
  const { start } = ai;
  useEffect(() => {
    void start(defineRequest({ key: src, word, context, near, source: sourceForUrl(src) }));
  }, [start]);

  useEffect(() => {
    const observer = new ResizeObserver(() =>
      // The body's own height: the document's scrollHeight never drops below the frame's, so it could only grow.
      tell({ type: 'reader-define-size', height: document.body.getBoundingClientRect().height }),
    );
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="define-card" aria-label={`Definition of ${word}`}>
      <AiNote
        view={ai.view}
        onStop={ai.stop}
        onApprove={ai.approve}
        onDismiss={() => tell({ type: 'reader-define-close' })}
      />
      <SaveNotePrompt
        view={ai.view}
        onSave={async (note) => {
          // Anchored by quote and context like an article highlight, so it shows when the page opens in the reader.
          const res = await sendMessage({
            type: 'ANNOT_ADD',
            draft: {
              docKey: annotationDocKey(src),
              docUrl: src,
              paperId: null,
              kind: 'highlight',
              anchor: { kind: 'text', blockIndex: 0, quote: word, prefix, suffix },
              text: word,
              color: DEFAULT_ANNOTATION_COLOR,
              note,
            },
          });
          // A refused save (the annotation cap) leaves the card up rather than pretending it kept the note.
          if (res.ok) tell({ type: 'reader-define-close' });
        }}
      />
    </main>
  );
}

initTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DefineCard />
  </React.StrictMode>,
);

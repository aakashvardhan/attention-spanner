import { useMemo, useState } from 'react';
import { sendMessage } from '../../../shared/messages';
import { localDate } from '../../../shared/format';
import { readerPageUrl } from '../../../shared/pdf';
import { paperThinking, todaysQuestion } from '../../../shared/thinking';
import { usePapers } from '../../../shared/hooks/usePapers';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import type { Deck } from '../../../shared/types';
import { emptyPaperDraft, PaperForm } from './PaperForm';
import { PaperRow } from './PaperRow';

export function PaperDeckView({ deck }: { deck: Deck }) {
  const [allDecks] = useStorageValue('decks');
  const { byDeck, addPaper, updatePaper, deletePaper } = usePapers();
  const [adding, setAdding] = useState(false);
  const [annotations] = useStorageValue('annotations');
  const [provocations] = useStorageValue('provocations');
  const day = localDate();
  const skipKey = `pp-skip-${day}`;
  const [skipped, setSkipped] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(skipKey);
    } catch {
      return null;
    }
  });
  const [answer, setAnswer] = useState('');

  // Papers can only move between paper decks
  const decks = allDecks.filter((d) => d.kind === 'papers');
  const papers = byDeck.get(deck.id) ?? [];

  const thinking = useMemo(
    () => new Map(papers.map((p) => [p.id, paperThinking(p.id, annotations, provocations)])),
    [papers, annotations, provocations],
  );
  const totalXp = [...thinking.values()].reduce((n, t) => n + t.xp, 0);
  const question = todaysQuestion(papers.map((p) => p.id), provocations, day);
  const showQuestion = question && skipped !== question.id;
  const questionPaper = papers.find((p) => p.id === question?.paperId);

  const head = (
    <div className="pp-deck-head">
      <h2 className="library-deck-name">{deck.name}</h2>
      <span className="pp-deck-xp">{totalXp} XP</span>
    </div>
  );

  return (
    <main className="fc-main">
      {head}
      {showQuestion && (
        <div className="pp-today">
          <p className="pp-today-kicker">Today’s question · from your own doubt</p>
          <p className="pp-today-q">{question.question}</p>
          <div className="pp-today-actions">
            <input
              type="text"
              aria-label="Your answer"
              value={answer}
              placeholder="One line…"
              onChange={(e) => setAnswer(e.target.value)}
            />
            <button
              className="fc-primary-btn"
              disabled={!answer.trim()}
              onClick={() => {
                void sendMessage({
                  type: 'PROV_UPDATE',
                  id: question.id,
                  patch: { status: 'answered', answer: answer.trim() },
                });
                setAnswer('');
              }}
            >
              Answer in one line
            </button>
            {questionPaper && (
              <a
                className="ghost-btn"
                href={`${readerPageUrl(questionPaper.pdf?.url ?? questionPaper.url)}#page=${question.page}`}
                target="_blank"
                rel="noreferrer"
              >
                Reopen at p. {question.page}
              </a>
            )}
            <button
              className="ghost-btn"
              onClick={() => {
                setSkipped(question.id);
                try {
                  sessionStorage.setItem(skipKey, question.id);
                } catch {
                  /* hidden until reload */
                }
              }}
            >
              Not today
            </button>
          </div>
        </div>
      )}
      {adding ? (
        <div className="panel">
          <h2>Add a paper</h2>
          <PaperForm
            decks={decks}
            initial={emptyPaperDraft(deck.id)}
            submitLabel="Add paper"
            onCancel={() => setAdding(false)}
            onSubmit={async (draft) => {
              const res = await addPaper(draft);
              if (res.ok) setAdding(false);
              return res;
            }}
          />
        </div>
      ) : (
        <button className="fc-primary-btn pp-add-btn" onClick={() => setAdding(true)}>
          + Add a paper
        </button>
      )}

      {papers.length === 0 && !adding && (
        <div className="panel fc-empty">
          <p>No papers in this deck yet. Add one above — paste an arXiv or DOI link and the
            title, authors, venue, and citations fill themselves in.</p>
        </div>
      )}

      <div className="pp-list">
        {papers.map((paper) => (
          <PaperRow
            key={paper.id}
            paper={paper}
            thinking={thinking.get(paper.id)!}
            decks={decks}
            onUpdate={updatePaper}
            onDelete={deletePaper}
          />
        ))}
      </div>
    </main>
  );
}

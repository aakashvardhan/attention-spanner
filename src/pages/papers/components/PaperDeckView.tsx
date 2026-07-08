import { useState } from 'react';
import { usePapers } from '../../../shared/hooks/usePapers';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import type { Deck } from '../../../shared/types';
import { emptyPaperDraft, PaperForm } from './PaperForm';
import { PaperRow } from './PaperRow';

export function PaperDeckView({ deck }: { deck: Deck }) {
  const [allDecks] = useStorageValue('decks');
  const { byDeck, addPaper, updatePaper, deletePaper } = usePapers();
  const [adding, setAdding] = useState(false);

  // Papers can only move between paper decks
  const decks = allDecks.filter((d) => d.kind === 'papers');
  const papers = byDeck.get(deck.id) ?? [];

  return (
    <main className="fc-main">
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
            decks={decks}
            onUpdate={updatePaper}
            onDelete={deletePaper}
          />
        ))}
      </div>
    </main>
  );
}

import { useState } from 'react';
import { clozeIndexes, clozeText } from '../../../shared/cloze';
import { localDate } from '../../../shared/format';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';
import { dueCounts, newIntroducedToday } from '../../../shared/srs';
import type { Deck, FlashNote, FlashNoteType } from '../../../shared/types';

export function DeckView({ deck, onStudy }: { deck: Deck; onStudy: () => void }) {
  const [notes] = useStorageValue('flashNotes');
  const [cards] = useStorageValue('flashCards');
  const [srsDaily] = useStorageValue('srsDaily');
  const [editing, setEditing] = useState<FlashNote | null>(null);

  const deckNotes = notes.filter((n) => n.deckId === deck.id);
  const deckCards = cards.filter((c) => c.deckId === deck.id);
  const counts = dueCounts(cards, Date.now(), newIntroducedToday(srsDaily, localDate()))[deck.id];
  const due = counts ? counts.newCount + counts.learningCount + counts.reviewCount : 0;

  return (
    <main className="fc-main">
      <div className="panel fc-stats">
        <div className="fc-stat">
          <span className="fc-stat-value fc-new">{counts?.newCount ?? 0}</span>
          <span className="fc-stat-label">New</span>
        </div>
        <div className="fc-stat">
          <span className="fc-stat-value fc-learning">{counts?.learningCount ?? 0}</span>
          <span className="fc-stat-label">Learning</span>
        </div>
        <div className="fc-stat">
          <span className="fc-stat-value fc-review">{counts?.reviewCount ?? 0}</span>
          <span className="fc-stat-label">Due</span>
        </div>
        <div className="fc-stat">
          <span className="fc-stat-value">{deckCards.length}</span>
          <span className="fc-stat-label">Total cards</span>
        </div>
        <button
          className="fc-study-btn fc-stats-study"
          disabled={due === 0}
          title={
            due > 0
              ? 'Start reviewing'
              : deckCards.length > 0
                ? 'All caught up — nothing due right now'
                : 'Add notes below first'
          }
          onClick={onStudy}
        >
          ▶ Study now
        </button>
      </div>

      <ReviewHistory deckId={deck.id} />

      <section className="panel">
        <h2>{editing ? 'Edit note' : 'Add note'}</h2>
        <NoteForm
          key={editing?.id ?? 'new'}
          deck={deck}
          editing={editing}
          onDone={() => setEditing(null)}
        />
      </section>

      <section className="panel">
        <h2>Notes ({deckNotes.length})</h2>
        {deckNotes.length === 0 && <p className="fc-hint">No notes in this deck yet.</p>}
        <div className="fc-note-list">
          {deckNotes.map((note) => {
            const noteCards = deckCards.filter((c) => c.noteId === note.id);
            return (
              <div className="fc-note-row" key={note.id}>
                <span className="fc-note-type" title={note.type === 'cloze' ? 'Cloze' : 'Basic'}>
                  {note.type === 'cloze' ? '⬚' : note.reversed ? '⇄' : '→'}
                </span>
                <span className="fc-note-front">
                  {note.type === 'cloze' ? clozeText(note.front, 0, 'back') : note.front}
                </span>
                <span className="fc-note-cards" title="Cards from this note">
                  {noteCards.length} card{noteCards.length === 1 ? '' : 's'}
                </span>
                <button className="ghost-btn" title="Edit note" onClick={() => setEditing(note)}>
                  ✎
                </button>
                <button
                  className="ghost-btn"
                  title="Delete note"
                  onClick={() => {
                    if (window.confirm('Delete this note and its cards?'))
                      void sendMessage({ type: 'FLASH_DELETE_NOTE', id: note.id });
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function NoteForm({
  deck,
  editing,
  onDone,
}: {
  deck: Deck;
  editing: FlashNote | null;
  onDone: () => void;
}) {
  const [noteType, setNoteType] = useState<FlashNoteType>(editing?.type ?? 'basic');
  const [front, setFront] = useState(editing?.front ?? '');
  const [back, setBack] = useState(editing?.back ?? '');
  const [reversed, setReversed] = useState(editing?.reversed ?? false);
  const [error, setError] = useState<string | null>(null);

  const clozeCount = noteType === 'cloze' ? clozeIndexes(front).length : 0;
  const cardCount = noteType === 'cloze' ? clozeCount : reversed ? 2 : 1;

  const save = async () => {
    try {
      const res = editing
        ? await sendMessage({ type: 'FLASH_UPDATE_NOTE', id: editing.id, front, back, reversed })
        : await sendMessage({
            type: 'FLASH_ADD_NOTE',
            deckId: deck.id,
            noteType,
            front,
            back,
            reversed,
          });
      if (!res?.ok) {
        setError(res?.error ?? 'Could not save note.');
        return;
      }
      setError(null);
      setFront('');
      setBack('');
      onDone();
    } catch {
      setError('Lost connection to the extension — close and reopen this tab.');
    }
  };

  return (
    <form
      className="fc-note-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!editing && (
        <div className="fc-type-picker">
          <button
            type="button"
            className={noteType === 'basic' ? 'fc-type-btn active' : 'fc-type-btn'}
            onClick={() => setNoteType('basic')}
          >
            Basic
          </button>
          <button
            type="button"
            className={noteType === 'cloze' ? 'fc-type-btn active' : 'fc-type-btn'}
            onClick={() => setNoteType('cloze')}
          >
            Cloze
          </button>
        </div>
      )}

      <textarea
        value={front}
        onChange={(e) => setFront(e.target.value)}
        rows={noteType === 'cloze' ? 3 : 2}
        placeholder={
          noteType === 'cloze'
            ? 'Text with deletions, e.g. The {{c1::mitochondria}} makes {{c2::ATP}}'
            : 'Front'
        }
      />
      <textarea
        value={back}
        onChange={(e) => setBack(e.target.value)}
        rows={2}
        placeholder={noteType === 'cloze' ? 'Extra info shown on the back (optional)' : 'Back'}
      />

      {noteType === 'basic' && (
        <label className="fc-reversed">
          <input
            type="checkbox"
            checked={reversed}
            onChange={(e) => setReversed(e.target.checked)}
          />
          Also create a reversed card (Back → Front)
        </label>
      )}

      <div className="fc-form-foot">
        <span className="fc-hint">
          {noteType === 'cloze' && clozeCount === 0
            ? 'Add at least one {{c1::…}} deletion'
            : `${cardCount} card${cardCount === 1 ? '' : 's'} ${editing ? 'after save' : 'will be created'}`}
          {editing?.type === 'cloze' && ' — renumbering deletions resets those cards'}
        </span>
        <div className="fc-form-actions">
          {editing && (
            <button type="button" className="ghost-btn" onClick={onDone}>
              Cancel
            </button>
          )}
          <button type="submit" className="fc-primary-btn" disabled={!front.trim()}>
            {editing ? 'Save' : 'Add note'}
          </button>
        </div>
      </div>
      {error && <p className="fc-error">{error}</p>}
    </form>
  );
}

function ReviewHistory({ deckId }: { deckId: string }) {
  const [srsDaily] = useStorageValue('srsDaily');
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (29 - i));
    const key = localDate(d);
    return { key, count: srsDaily[key]?.reviews[deckId] ?? 0 };
  });
  const max = Math.max(1, ...days.map((d) => d.count));
  if (days.every((d) => d.count === 0)) return null;

  return (
    <section className="panel">
      <h2>Reviews — last 30 days</h2>
      <div className="fc-history">
        {days.map((d) => (
          <div className="fc-history-col" key={d.key} title={`${d.key}: ${d.count}`}>
            <div
              className="fc-history-bar"
              style={{ height: `${Math.max(d.count > 0 ? 8 : 2, (d.count / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

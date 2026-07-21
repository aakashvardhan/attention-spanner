import { useEffect } from 'react';
import type { MeetingNote, NoteBlock } from '../../shared/meetingNotes';

/** Full-screen reader overlay for one cached meeting note (see MeetingNotesPanel). */
export function MeetingNoteReader({
  note,
  onClose,
}: {
  note: MeetingNote;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="mn-overlay" onClick={onClose}>
      <article className="mn-reader" onClick={(e) => e.stopPropagation()}>
        <header className="mn-reader-head">
          <div>
            <h2>{note.title}</h2>
            <p className="mn-date">
              {new Date(note.dateMs).toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
              {note.url && (
                <>
                  {' · '}
                  <a href={note.url} target="_blank" rel="noreferrer">
                    Open in Notion ↗
                  </a>
                </>
              )}
            </p>
          </div>
          <button className="ghost-btn" title="Close (Esc)" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="mn-reader-body">
          {note.blocks.length === 0 && <p className="panel-empty">This note has no content.</p>}
          {note.blocks.map((block, i) => (
            <Block key={i} block={block} />
          ))}
          {note.truncated && <p className="mn-truncated">(truncated — open in Notion for the rest)</p>}
        </div>
      </article>
    </div>
  );
}

function Block({ block }: { block: NoteBlock }) {
  const indent = (depth: number) => ({ paddingLeft: depth * 16 });
  switch (block.type) {
    case 'heading':
      return block.level === 1 ? (
        <h3>{block.text}</h3>
      ) : block.level === 2 ? (
        <h4>{block.text}</h4>
      ) : (
        <h5>{block.text}</h5>
      );
    case 'paragraph':
      return <p style={indent(block.depth)}>{block.text}</p>;
    case 'bullet':
      return (
        <p className="mn-li" style={indent(block.depth)}>
          <span className="mn-marker">•</span> {block.text}
        </p>
      );
    case 'number':
      return (
        <p className="mn-li" style={indent(block.depth)}>
          <span className="mn-marker">–</span> {block.text}
        </p>
      );
    case 'todo':
      return (
        <p className="mn-li" style={indent(block.depth)}>
          <span className="mn-marker">{block.checked ? '☑' : '☐'}</span>{' '}
          <span className={block.checked ? 'mn-done' : undefined}>{block.text}</span>
        </p>
      );
    case 'quote':
      return <blockquote>{block.text}</blockquote>;
    case 'code':
      return (
        <pre className="mn-code">
          <code>{block.text}</code>
        </pre>
      );
    case 'divider':
      return <hr />;
  }
}

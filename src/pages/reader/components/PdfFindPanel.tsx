import { useMemo, useState } from 'react';

export function PdfFindPanel({
  pages,
  onJump,
  onClose,
}: {
  pages: string[] | null;
  onJump: (page: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || !pages) return [];
    return pages.flatMap((text, index) => {
      const at = text.toLocaleLowerCase().indexOf(needle);
      if (at < 0) return [];
      const start = Math.max(0, at - 60);
      const end = Math.min(text.length, at + needle.length + 100);
      return [{ page: index + 1, excerpt: `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}` }];
    }).slice(0, 50);
  }, [pages, query]);

  return (
    <aside className="reader-find" aria-label="Find in paper">
      <div className="reader-related-head">
        <h2>Find in paper</h2>
        <button className="ghost-btn" onClick={onClose} aria-label="Close find">✕</button>
      </div>
      <input className="reader-find-input" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search text" />
      {pages === null ? <p className="reader-notes-empty">Indexing text…</p> : query.trim() && (
        <p className="reader-notes-empty">{matches.length ? `${matches.length}${matches.length === 50 ? '+' : ''} pages found` : 'No matches.'}</p>
      )}
      <ul className="reader-find-results">
        {matches.map((match) => <li key={match.page}><button onClick={() => onJump(match.page)}><strong>Page {match.page}</strong><span>{match.excerpt}</span></button></li>)}
      </ul>
    </aside>
  );
}

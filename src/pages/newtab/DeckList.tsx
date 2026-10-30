import { useState } from 'react';
import type { OpenQuestion } from '../../shared/thinking';
import { ShowAll } from './ShowAll';
import { visibleRows } from './visibleRows';

/**
 * The deck's Open questions column on the new tab: provocations still open or
 * unsure, newest first. A row opens the reader at that question's page, the
 * same link the deck uses. Nothing open, no section.
 */
export function DeckList({ items }: { items: OpenQuestion[] }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const { shown, hidden } = visibleRows(items, expanded);
  return (
    <section className="read-section" aria-label="Deck">
      <h2 className="label">Deck</h2>
      <ul>
        {shown.map((q) => (
          <li key={q.id}>
            <a className="row" data-story href={q.href}>
              <span className="row-title">
                {q.question}
                <span className="row-why">{q.paperTitle}</span>
              </span>
              <span className="row-state">{q.status}</span>
            </a>
          </li>
        ))}
      </ul>
      <ShowAll total={items.length} hidden={hidden} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
    </section>
  );
}

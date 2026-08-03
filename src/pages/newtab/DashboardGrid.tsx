import type { ReactNode } from 'react';
import type { DashboardMode, DashCardId } from '../../shared/types';

export interface DashCard {
  id: DashCardId;
  title: string;
  Component: () => React.JSX.Element;
}

const PRIMARY_BY_MODE: Record<DashboardMode, readonly DashCardId[]> = {
  focused: ['dayplan', 'agenda', 'tasks', 'continue', 'streak'],
  balanced: ['dayplan', 'agenda', 'tasks', 'inbox', 'continue', 'streak'],
  research: ['continue', 'feeds', 'papers', 'recordings', 'flashcards', 'tasks'],
};

const PRIMARY_COLUMNS: Record<DashboardMode, readonly (readonly DashCardId[])[]> = {
  focused: [
    ['dayplan', 'tasks'],
    ['agenda', 'continue', 'streak'],
  ],
  balanced: [
    ['dayplan', 'tasks', 'streak'],
    ['agenda', 'inbox', 'continue'],
  ],
  research: [
    ['continue', 'feeds', 'tasks'],
    ['papers', 'recordings', 'flashcards'],
  ],
};

export function cardsForDashboardMode(
  mode: DashboardMode,
  cards: readonly DashCard[],
  unavailable: ReadonlySet<DashCardId>,
): { primary: DashCard[]; library: DashCard[] } {
  const visible = cards.filter((card) => !unavailable.has(card.id));
  const byId = new Map(visible.map((card) => [card.id, card]));
  const primary = PRIMARY_BY_MODE[mode]
    .map((id) => byId.get(id))
    .filter((card): card is DashCard => card !== undefined);
  const primaryIds = new Set(primary.map((card) => card.id));
  const library = visible.filter((card) => !primaryIds.has(card.id));
  return { primary, library };
}

export function cardsIntoColumns(cards: readonly DashCard[], count: number): DashCard[][] {
  const columns = Array.from({ length: Math.max(1, count) }, () => [] as DashCard[]);
  cards.forEach((card, index) => columns[index % columns.length].push(card));
  return columns.filter((column) => column.length > 0);
}

function CardSlot({ card }: { card: DashCard }) {
  return (
    <div className={`dash-slot dash-slot--${card.id}`}>
      <card.Component />
    </div>
  );
}

export function DashboardGrid({
  cards,
  mode,
  unavailable,
  tray,
  insights,
}: {
  cards: readonly DashCard[];
  mode: DashboardMode;
  unavailable: ReadonlySet<DashCardId>;
  tray: ReactNode;
  insights: ReactNode;
}) {
  const { primary, library } = cardsForDashboardMode(mode, cards, unavailable);
  const primaryById = new Map(primary.map((card) => [card.id, card]));
  const primaryColumns = PRIMARY_COLUMNS[mode]
    .map((ids) =>
      ids
        .map((id) => primaryById.get(id))
        .filter((card): card is DashCard => card !== undefined),
    )
    .filter((column) => column.length > 0);
  const libraryColumns = cardsIntoColumns(library, 3);

  return (
    <div className={`dash-layout dash-layout--${mode}`}>
      <section className="dash-primary" aria-label={`${mode} dashboard`}>
        <div className="dash-primary-columns">
          {primaryColumns.map((column, index) => (
            <div className="dash-column" key={index}>
              {column.map((card) => (
                <CardSlot key={card.id} card={card} />
              ))}
            </div>
          ))}
        </div>
      </section>

      <details className="dash-insights">
        <summary>
          <span>
            <strong>Insights</strong>
            <small>Your activity and working rhythm</small>
          </span>
          <span className="dash-disclosure" aria-hidden="true">
            ›
          </span>
        </summary>
        <div className="dash-insights-body">{insights}</div>
      </details>

      <section className="dash-library" aria-labelledby="dash-library-title">
        <header className="dash-section-head">
          <div>
            <h2 id="dash-library-title">Library and tools</h2>
            <p>Everything useful, without competing with today.</p>
          </div>
        </header>
        <div className="dash-library-grid">
          {libraryColumns.map((column, index) => (
            <div className="dash-column" key={index}>
              {column.map((card) => (
                <CardSlot key={card.id} card={card} />
              ))}
            </div>
          ))}
        </div>
        {tray}
      </section>
    </div>
  );
}

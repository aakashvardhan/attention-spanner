import { useMemo, useState } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { DEFAULT_SETTINGS, patchSettings } from '../../shared/storage';
import type { DashCardId, Settings } from '../../shared/types';

export interface DashCard {
  id: DashCardId;
  title: string;
  Component: () => React.JSX.Element;
}

type CardListKey = 'dashHiddenCards' | 'dashFullWidthCards';

function toggleInList(settings: Settings, key: CardListKey, id: DashCardId) {
  const current = settings[key];
  const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  void patchSettings({ [key]: next });
}

export function DashboardGrid({ cards }: { cards: readonly DashCard[] }) {
  const [storedSettings] = useStorageValue('settings');
  const settings: Settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  const [editing, setEditing] = useState(false);
  const [activeId, setActiveId] = useState<DashCardId | null>(null);

  const reducedMotion = useMemo(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // Reconcile stored order with the registry: drop unknown ids, append new ones
  const knownIds = cards.map((c) => c.id);
  const order = [
    ...settings.dashCardOrder.filter((id) => knownIds.includes(id)),
    ...knownIds.filter((id) => !settings.dashCardOrder.includes(id)),
  ];
  const hidden = new Set(settings.dashHiddenCards);
  const visibleOrder = order.filter((id) => !hidden.has(id));
  const hiddenOrder = order.filter((id) => hidden.has(id));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragStart = (e: DragStartEvent) => setActiveId(e.active.id as DashCardId);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const from = order.indexOf(active.id as DashCardId);
    const to = order.indexOf(over.id as DashCardId);
    if (from < 0 || to < 0) return;
    void patchSettings({ dashCardOrder: arrayMove(order, from, to) });
  };

  const activeCard = activeId ? cards.find((c) => c.id === activeId) : null;

  return (
    <>
      <div className="dash-toolbar">
        <button
          className={editing ? 'ghost-btn editing' : 'ghost-btn'}
          onClick={() => setEditing((e) => !e)}
        >
          {editing ? '✓ Done' : '⚙ Customize'}
        </button>
      </div>
      {editing && (
        <div className="dash-customize-bar">
          <span className="row-label">Columns</span>
          <div className="dash-col-picker">
            {([1, 2, 3, 4] as const).map((n) => (
              <button
                key={n}
                className={settings.dashColumns === n ? 'col-btn active' : 'col-btn'}
                onClick={() => void patchSettings({ dashColumns: n })}
              >
                {n}
              </button>
            ))}
          </div>
          {hiddenOrder.length > 0 && (
            <div className="dash-hidden-tray">
              <span className="row-label">Hidden</span>
              {hiddenOrder.map((id) => {
                const card = cards.find((c) => c.id === id);
                if (!card) return null;
                return (
                  <button
                    key={id}
                    className="hidden-chip"
                    onClick={() => toggleInList(settings, 'dashHiddenCards', id)}
                  >
                    {card.title} +
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <SortableContext items={visibleOrder} strategy={rectSortingStrategy}>
          <div
            className={editing ? 'dash-grid editing' : 'dash-grid'}
            style={{ '--dash-cols': settings.dashColumns } as React.CSSProperties}
          >
            {visibleOrder.map((id) => {
              const card = cards.find((c) => c.id === id);
              if (!card) return null;
              return (
                <SortableCard
                  key={id}
                  card={card}
                  editing={editing}
                  fullWidth={settings.dashFullWidthCards.includes(id)}
                  reducedMotion={reducedMotion}
                  settings={settings}
                />
              );
            })}
          </div>
        </SortableContext>
        {visibleOrder.length === 0 && (
          <p className="dash-all-hidden">
            All cards hidden — use the tray above to bring them back.
          </p>
        )}
        <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
          {activeCard && <div className="dash-card-ghost">{activeCard.title}</div>}
        </DragOverlay>
      </DndContext>
    </>
  );
}

function SortableCard({
  card,
  editing,
  fullWidth,
  reducedMotion,
  settings,
}: {
  card: DashCard;
  editing: boolean;
  fullWidth: boolean;
  reducedMotion: boolean;
  settings: Settings;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id, disabled: !editing });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: reducedMotion ? undefined : transition,
  };

  const className = ['dash-card', fullWidth && 'full-width', isDragging && 'dragging']
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={setNodeRef} style={style} className={className}>
      {editing && (
        <div className="dash-card-controls">
          <button
            ref={setActivatorNodeRef}
            className="dash-handle"
            {...attributes}
            {...listeners}
            aria-label={`Move ${card.title}`}
            title="Drag to move"
          >
            ⠿
          </button>
          <div className="dash-card-actions">
            <button
              className="ghost-btn"
              title={fullWidth ? 'Half width' : 'Full width'}
              onClick={() => toggleInList(settings, 'dashFullWidthCards', card.id)}
            >
              {fullWidth ? '▭' : '⬌'}
            </button>
            <button
              className="ghost-btn"
              title="Hide card"
              onClick={() => toggleInList(settings, 'dashHiddenCards', card.id)}
            >
              ✕
            </button>
          </div>
        </div>
      )}
      <card.Component />
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from '../types';

/**
 * Drag-to-reorder wrapper for open tasks. The dropped order is applied
 * locally right away, then confirmed when the service-worker write lands —
 * otherwise the row would snap back for a frame during the roundtrip.
 */
export function SortableTaskList({
  tasks,
  onMove,
  renderRow,
}: {
  tasks: Task[];
  onMove: (id: string, toIndex: number) => void;
  renderRow: (task: Task, handle: React.JSX.Element) => React.JSX.Element;
}) {
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  const ordered = useMemo(() => {
    if (!pendingOrder) return tasks;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const reordered = pendingOrder.flatMap((id) => byId.get(id) ?? []);
    // A task was added/removed elsewhere while the move was in flight —
    // the pending order no longer describes this list, so fall back
    return reordered.length === tasks.length ? reordered : tasks;
  }, [tasks, pendingOrder]);

  useEffect(() => {
    if (pendingOrder && tasks.map((t) => t.id).join('\n') === pendingOrder.join('\n')) {
      setPendingOrder(null);
    }
  }, [tasks, pendingOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = ordered.map((t) => t.id);
    const from = ids.indexOf(active.id as string);
    const to = ids.indexOf(over.id as string);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    setPendingOrder(ids);
    onMove(active.id as string, to);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ordered.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        {ordered.map((task) => (
          <SortableRow key={task.id} task={task} renderRow={renderRow} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  task,
  renderRow,
}: {
  task: Task;
  renderRow: (task: Task, handle: React.JSX.Element) => React.JSX.Element;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging && { opacity: 0.5, zIndex: 1, position: 'relative' as const }),
  };

  const handle = (
    <button
      ref={setActivatorNodeRef}
      className="task-drag-handle"
      {...attributes}
      {...listeners}
      aria-label="Drag to reorder"
      title="Drag to reorder"
    >
      ⠿
    </button>
  );

  return (
    <div ref={setNodeRef} style={style}>
      {renderRow(task, handle)}
    </div>
  );
}

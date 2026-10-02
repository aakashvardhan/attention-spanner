import { useEffect, useRef, useState } from 'react';
import type { FlatOutlineItem } from '../../../shared/pdfOutline';
import { crossedSection, sectionDoneLabel } from '../../../shared/readingAids';

/**
 * The outline folded to tick marks on the left edge: one per top-level
 * section, passed ones filled, the current one lit. Hover to read the names.
 */
export function OutlineRail({
  sections,
  current,
  onJump,
}: {
  sections: FlatOutlineItem[];
  current: number;
  onJump: (page: number) => void;
}) {
  if (sections.length === 0) return null;
  return (
    <nav className="reader-rail" aria-label="Sections">
      <ol>
        {sections.map((s, i) => (
          <li key={`${s.page}-${i}`}>
            <button
              type="button"
              className="reader-rail-tick"
              data-state={i < current ? 'done' : i === current ? 'current' : undefined}
              aria-current={i === current ? 'location' : undefined}
              onClick={() => onJump(s.page)}
            >
              <span className="reader-rail-label">{s.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** "Section 3 done · 2 left" for three seconds after reading into the next section. */
export function useSectionToast(sections: FlatOutlineItem[], current: number): string | null {
  const prev = useRef(current);
  const mountedAt = useRef(Date.now());
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    const finished = crossedSection(prev.current, current);
    prev.current = current;
    // ponytail: a time guard, not a "restored" signal. Reopening a paper scrolls
    // to where you were, which can cross exactly one section; that is not
    // reading. Thread the readers' restore flag through if 3s ever misfires.
    if (finished === null || Date.now() - mountedAt.current < 3000) return;
    setToast(sectionDoneLabel(finished, sections.length));
  }, [current, sections.length]);

  // The toast owns its own timer. Hung off the crossing effect, a scroll back
  // within 3s cleared the timer and left the message up for good.
  useEffect(() => {
    if (!toast) return;
    const timer = self.setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  return toast;
}

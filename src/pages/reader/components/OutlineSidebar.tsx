import type { FlatOutlineItem } from '../../../shared/pdfOutline';

/** Index of the heading the reader is currently "in" (mirrors headingForPage). */
function activeIndex(outline: FlatOutlineItem[], page: number): number {
  let best = -1;
  for (let i = 0; i < outline.length; i++) {
    if (outline[i].page <= page && (best === -1 || outline[i].page >= outline[best].page)) best = i;
  }
  return best;
}

export function OutlineSidebar({
  outline,
  currentPage,
  onJump,
}: {
  outline: FlatOutlineItem[];
  currentPage: number;
  onJump: (page: number) => void;
}) {
  const active = activeIndex(outline, currentPage);
  return (
    <nav className="reader-outline">
      <h2>Outline</h2>
      <ul>
        {outline.map((item, i) => (
          <li key={i}>
            <button
              className={i === active ? 'reader-outline-item active' : 'reader-outline-item'}
              style={{ paddingLeft: 10 + item.level * 14 }}
              title={item.title}
              onClick={() => onJump(item.page)}
            >
              {item.title}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

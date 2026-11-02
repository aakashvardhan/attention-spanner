import { sectionIndexAt, type FlatOutlineItem } from '../../../shared/pdfOutline';

export function OutlineSidebar({
  outline,
  currentPage,
  onJump,
}: {
  outline: FlatOutlineItem[];
  currentPage: number;
  onJump: (page: number) => void;
}) {
  const active = sectionIndexAt(outline, currentPage);
  return (
    <nav className="reader-outline" aria-label="Outline">
      <h2>Outline</h2>
      {outline.length === 0 && <p className="reader-notes-empty">This paper has no outline.</p>}
      {outline.length > 0 && (
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
      )}
    </nav>
  );
}

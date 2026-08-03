import type { ReactNode } from 'react';
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
  activeTab = 'outline',
  onTabChange,
  aiOutline,
}: {
  outline: FlatOutlineItem[];
  currentPage: number;
  onJump: (page: number) => void;
  activeTab?: 'outline' | 'ai';
  onTabChange?: (tab: 'outline' | 'ai') => void;
  aiOutline?: ReactNode;
}) {
  const active = activeIndex(outline, currentPage);
  return (
    <nav className="reader-outline">
      {aiOutline ? <div className="reader-outline-tabs"><button className={activeTab === 'outline' ? 'active' : ''} onClick={() => onTabChange?.('outline')}>Outline</button><button className={activeTab === 'ai' ? 'active' : ''} onClick={() => onTabChange?.('ai')}>AI outline</button></div> : <h2>Outline</h2>}
      {activeTab === 'ai' && aiOutline ? aiOutline : <ul>{outline.map((item, i) => (
        <li key={i}><button className={i === active ? 'reader-outline-item active' : 'reader-outline-item'} style={{ paddingLeft: 10 + item.level * 14 }} title={item.title} onClick={() => onJump(item.page)}>{item.title}</button></li>
      ))}</ul>}
    </nav>
  );
}

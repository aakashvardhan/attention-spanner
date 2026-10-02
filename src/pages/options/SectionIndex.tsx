import { useEffect, useState } from 'react';

/** The sticky table of contents; the section in view is lit. */
export function SectionIndex() {
  const [sections, setSections] = useState<{ id: string; title: string }[]>([]);
  const [active, setActive] = useState('');

  useEffect(() => {
    const nodes = [...document.querySelectorAll<HTMLElement>('main section[id]')];
    setSections(nodes.map((n) => ({ id: n.id, title: n.querySelector('h2')?.textContent ?? n.id })));
    // The section you are in is the last one whose top has passed the upper
    // third of the window. "Topmost intersecting" picks the previous section
    // whenever its tail still pokes into view, which is most of the time.
    const update = () => {
      const line = window.innerHeight * 0.3;
      let current = nodes[0]?.id ?? '';
      for (const node of nodes) if (node.getBoundingClientRect().top <= line) current = node.id;
      // The ends win outright: the top of the page is the first section, and the
      // last one may be too short to ever reach the line.
      const doc = document.documentElement;
      if (window.scrollY <= 0) current = nodes[0]?.id ?? '';
      else if (window.scrollY + window.innerHeight >= doc.scrollHeight - 2) current = nodes.at(-1)?.id ?? current;
      setActive(current);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  return (
    <nav className="colophon-index" aria-label="Settings sections">
      <ol>
        {sections.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} aria-current={s.id === active ? 'location' : undefined}>
              {s.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

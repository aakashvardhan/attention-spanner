import { useMemo } from 'react';
import 'katex/dist/katex.min.css';
import { renderMarkdown } from './renderMarkdown';
import './markdown.css';

/** Assistant answer rendered as Markdown + LaTeX. Logic is in renderMarkdown.ts. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

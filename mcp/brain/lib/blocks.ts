import { GFM, parser as base } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';

/**
 * Paragraphs, list items, headings, tasks and code spans of a note body, from
 * CodeMirror's own CommonMark + GFM parser, so the index and the editor
 * never disagree about structure. Offsets are into the body.
 */

const parser = base.configure(GFM);

export type BlockKind = 'heading' | 'paragraph' | 'item' | 'code' | 'table' | 'quote' | 'html' | 'rule';
export interface Block { kind: BlockKind; from: number; to: number; text: string; section: string; level?: number }
export interface Heading { text: string; level: number; from: number; to: number }
export interface Task { text: string; done: boolean; from: number; to: number }
export interface Structure { blocks: Block[]; headings: Heading[]; tasks: Task[]; code: [number, number][] }

const KIND: Record<string, BlockKind> = {
  Paragraph: 'paragraph',
  FencedCode: 'code',
  CodeBlock: 'code',
  Table: 'table',
  Blockquote: 'quote',
  HTMLBlock: 'html',
  HorizontalRule: 'rule',
};
const LIST = new Set(['BulletList', 'OrderedList']);

function headingText(raw: string, atx: boolean): string {
  if (atx) return raw.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
  return raw.split(/\r?\n/).slice(0, -1).map((l) => l.trim()).join('\n');
}

export function structure(body: string): Structure {
  const tree = parser.parse(body);
  const s: Structure = { blocks: [], headings: [], tasks: [], code: [] };
  let section = '';

  const item = (li: SyntaxNode) => {
    let end = li.to;
    let isTask = false;
    for (let c = li.firstChild; c; c = c.nextSibling) {
      if (c.name === 'Task') isTask = true;
      if (LIST.has(c.name)) {
        end = c.from;
        break;
      }
    }
    const raw = body.slice(li.from, end).replace(/\s+$/, '');
    const marker = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(raw)?.[0] ?? '';
    const box = isTask ? /^\[([ xX])\][ \t]*/.exec(raw.slice(marker.length)) : null;
    const text = raw.slice(marker.length + (box?.[0].length ?? 0)).trim();
    s.blocks.push({ kind: 'item', from: li.from, to: end, text, section });
    if (box) s.tasks.push({ text, done: box[1] !== ' ', from: li.from, to: end });
    // Only nested lists are their own blocks; the item's paragraphs are its text.
    for (let c = li.firstChild; c; c = c.nextSibling) if (LIST.has(c.name)) visit(c);
  };

  const visit = (parent: SyntaxNode) => {
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      const h = /^(ATX|Setext)Heading(\d)$/.exec(c.name);
      if (h) {
        const text = headingText(body.slice(c.from, c.to), h[1] === 'ATX');
        const level = Number(h[2]);
        section = text;
        s.headings.push({ text, level, from: c.from, to: c.to });
        s.blocks.push({ kind: 'heading', from: c.from, to: c.to, text, section, level });
      } else if (LIST.has(c.name)) visit(c);
      else if (c.name === 'ListItem') item(c);
      else if (KIND[c.name]) s.blocks.push({ kind: KIND[c.name], from: c.from, to: c.to, text: body.slice(c.from, c.to), section });
    }
  };

  visit(tree.topNode);
  tree.iterate({
    enter: (n) => {
      if (n.name === 'FencedCode' || n.name === 'CodeBlock' || n.name === 'InlineCode') {
        s.code.push([n.from, n.to]);
        return false;
      }
      return undefined;
    },
  });
  return s;
}

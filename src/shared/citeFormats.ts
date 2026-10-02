import type { Paper } from './types';

/**
 * The common citation formats for "copy citation" in the reader. Pure string
 * building over the fields a Paper already has; anything missing is left out
 * rather than guessed.
 */

export type CiteStyle = 'apa' | 'mla' | 'bibtex';

export type CiteSource = Pick<Paper, 'title' | 'authors' | 'venue' | 'year' | 'url'>;

/** "Ashish Vaswani" → { first: 'Ashish', last: 'Vaswani' }. Last token is the surname. */
function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  const last = parts.pop() ?? '';
  return { first: parts.join(' '), last };
}

function names(authors: string): { first: string; last: string }[] {
  return authors
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map(splitName);
}

/** "Ashish Kumar" → "A. K." */
function initials(first: string): string {
  return first
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((p) => `${p[0].toUpperCase()}.`)
    .join(' ');
}

/** Strip a trailing period so formats can add their own punctuation. */
const bare = (s: string) => s.trim().replace(/\.$/, '');

function apa(src: CiteSource): string {
  const list = names(src.authors).map((n) => (n.first ? `${n.last}, ${initials(n.first)}` : n.last));
  let who = '';
  if (list.length === 1) who = list[0];
  else if (list.length > 1) who = `${list.slice(0, -1).join(', ')}, & ${list[list.length - 1]}`;
  const parts = [
    who && `${bare(who)}.`,
    `(${src.year ?? 'n.d.'}).`,
    `${bare(src.title)}.`,
    src.venue && `${bare(src.venue)}.`,
    src.url,
  ];
  return parts.filter(Boolean).join(' ');
}

function mla(src: CiteSource): string {
  const list = names(src.authors);
  let who = '';
  const inverted = (n: { first: string; last: string }) => (n.first ? `${n.last}, ${n.first}` : n.last);
  if (list.length === 1) who = inverted(list[0]);
  else if (list.length === 2) who = `${inverted(list[0])}, and ${list[1].first} ${list[1].last}`.trim();
  else if (list.length > 2) who = `${inverted(list[0])}, et al`;
  const tail = [src.venue && bare(src.venue), src.year].filter(Boolean).join(', ');
  const parts = [who && `${bare(who)}.`, `“${bare(src.title)}.”`, tail && `${tail}.`];
  return parts.filter(Boolean).join(' ');
}

function bibtex(src: CiteSource): string {
  const list = names(src.authors);
  const firstWord = src.title.toLowerCase().match(/[a-z0-9]+/)?.[0] ?? 'paper';
  const key = `${(list[0]?.last ?? 'anon').toLowerCase().replace(/[^a-z]/g, '')}${src.year ?? ''}${firstWord}`;
  const fields: [string, string | number | null][] = [
    ['title', src.title.trim()],
    ['author', list.map((n) => `${n.last}${n.first ? `, ${n.first}` : ''}`).join(' and ')],
    ['journal', src.venue.trim()],
    ['year', src.year],
    ['url', src.url],
  ];
  const body = fields
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `  ${k}={${v}}`)
    .join(',\n');
  return `@article{${key},\n${body}\n}`;
}

export function formatCitation(src: CiteSource, style: CiteStyle): string {
  if (style === 'apa') return apa(src);
  if (style === 'mla') return mla(src);
  return bibtex(src);
}

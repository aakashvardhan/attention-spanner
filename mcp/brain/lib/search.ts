import type { Block, Heading, Task } from './blocks';
import type { IndexEntry } from './entry';
import type { Q } from './query';

/**
 * Linear scan, ranked title, then heading, then body (spec, Search).
 * ponytail: linear scan; move to an inverted index past about 5,000 notes or
 * when bench:brain misses the 150 ms budget.
 */

export interface SearchDoc { path: string; title: string; body: string; tags: string[]; headings: Heading[]; blocks: Block[]; tasks: Task[] }
export interface Hit { path: string; title: string; score: number }

export const toSearchDoc = (e: IndexEntry): SearchDoc => ({ path: e.path, title: e.title, body: e.body, tags: e.tags, headings: e.headings, blocks: e.blocks, tasks: e.tasks });

type Ctx = { cs: boolean };
interface Scope { raw: string; low?: string }
const low = (s: Scope) => (s.low ??= s.raw.toLowerCase());

const compiled = new Map<string, RegExp>();
function re(src: string, cs: boolean): RegExp {
  const k = (cs ? 'c:' : 'i:') + src;
  let r = compiled.get(k);
  if (!r) {
    if (compiled.size > 100) compiled.clear();
    r = new RegExp(src, cs ? '' : 'i');
    compiled.set(k, r);
  }
  return r;
}

function inScope(q: Q, s: Scope, ctx: Ctx): boolean {
  switch (q.t) {
    case 'term':
      return ctx.cs ? s.raw.includes(q.v) : low(s).includes(q.v.toLowerCase());
    case 'regex':
      return re(q.v, ctx.cs).test(s.raw);
    case 'and':
      return q.a.every((x) => inScope(x, s, ctx));
    case 'or':
      return q.a.some((x) => inScope(x, s, ctx));
    case 'not':
      return !inScope(q.a, s, ctx);
    case 'op':
      // Inside a text scope, only case operators change anything; other scopes already narrowed the text.
      return inScope(q.a, s, q.op === 'match-case' ? { cs: true } : q.op === 'ignore-case' ? { cs: false } : ctx);
  }
}

function sections(d: SearchDoc): string[] {
  const cuts = [0, ...d.headings.map((h) => h.from), d.body.length];
  const out: string[] = [];
  for (let i = 0; i < cuts.length - 1; i++) out.push(d.body.slice(cuts[i], cuts[i + 1]));
  return out;
}

interface DocScopes { title: Scope; body: Scope }

function inDoc(q: Q, d: SearchDoc, ctx: Ctx, c: DocScopes): boolean {
  switch (q.t) {
    case 'term':
    case 'regex':
      return inScope(q, c.title, ctx) || inScope(q, c.body, ctx);
    case 'and':
      return q.a.every((x) => inDoc(x, d, ctx, c));
    case 'or':
      return q.a.some((x) => inDoc(x, d, ctx, c));
    case 'not':
      return !inDoc(q.a, d, ctx, c);
    case 'op': {
      const any = (texts: string[]) => texts.some((raw) => inScope(q.a, { raw }, ctx));
      switch (q.op) {
        case 'file':
          return inScope(q.a, c.title, ctx);
        case 'path':
          return inScope(q.a, { raw: d.path }, ctx);
        case 'content':
          return inScope(q.a, c.body, ctx);
        case 'tag': {
          const want = (q.a as { v: string }).v.replace(/^#/, '').toLowerCase();
          return d.tags.some((t) => t.toLowerCase() === want || t.toLowerCase().startsWith(want + '/'));
        }
        case 'line':
          return any(d.body.split('\n'));
        case 'block':
          return any(d.blocks.map((b) => b.text));
        case 'section':
          return any(sections(d));
        case 'task':
          return any(d.tasks.map((t) => t.text));
        case 'task-todo':
          return any(d.tasks.filter((t) => !t.done).map((t) => t.text));
        case 'task-done':
          return any(d.tasks.filter((t) => t.done).map((t) => t.text));
        case 'match-case':
          return inDoc(q.a, d, { cs: true }, c);
        case 'ignore-case':
          return inDoc(q.a, d, { cs: false }, c);
      }
    }
  }
}

/** Terms a hit is ranked by: everything not excluded and not a tag. */
function positives(q: Q, out: Q[] = []): Q[] {
  if (q.t === 'term' || q.t === 'regex') out.push(q);
  else if (q.t === 'and' || q.t === 'or') q.a.forEach((x) => positives(x, out));
  else if (q.t === 'op' && q.op !== 'tag') positives(q.a, out);
  return out;
}

function score(d: DocScopes, headings: Heading[], terms: Q[]): number {
  if (terms.some((t) => inScope(t, d.title, { cs: false }))) return 3;
  if (terms.some((t) => headings.some((h) => inScope(t, { raw: h.text }, { cs: false })))) return 2;
  return 1;
}

export const rankHits = (hits: Hit[]): Hit[] => hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

export function search(q: Q, docs: Iterable<SearchDoc>, opts: { limit?: number; deadline?: number; now?: () => number } = {}): { hits: Hit[]; partial: boolean } {
  const hits: Hit[] = [];
  if (q.t === 'and' && q.a.length === 0) return { hits, partial: false };
  const now = opts.now ?? (() => Date.now());
  const terms = positives(q);
  let partial = false;
  for (const d of docs) {
    if (opts.deadline !== undefined && now() > opts.deadline) {
      partial = true;
      break;
    }
    const c = { title: { raw: d.title }, body: { raw: d.body } };
    if (inDoc(q, d, { cs: false }, c)) hits.push({ path: d.path, title: d.title, score: score(c, d.headings, terms) });
  }
  return { hits: rankHits(hits).slice(0, opts.limit ?? hits.length), partial };
}

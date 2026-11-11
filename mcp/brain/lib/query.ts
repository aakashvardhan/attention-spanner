/**
 * Obsidian's search syntax (spec, Search): words (AND), "phrases", OR, (groups),
 * -exclude, /regex/, and operators. AND binds tighter than OR. A malformed query
 * throws QueryError with the position, never a partial parse.
 */

export type Op = 'file' | 'path' | 'content' | 'tag' | 'line' | 'block' | 'section' | 'task' | 'task-todo' | 'task-done' | 'match-case' | 'ignore-case';
export const OPS: readonly Op[] = ['file', 'path', 'content', 'tag', 'line', 'block', 'section', 'task', 'task-todo', 'task-done', 'match-case', 'ignore-case'];
export type Q =
  | { t: 'term'; v: string; phrase: boolean }
  | { t: 'regex'; v: string }
  | { t: 'and'; a: Q[] }
  | { t: 'or'; a: Q[] }
  | { t: 'not'; a: Q }
  | { t: 'op'; op: Op; a: Q };

export class QueryError extends Error {
  constructor(
    message: string,
    readonly pos: number,
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

type Tok = { k: '(' | ')' | '-' | 'OR' | 'word' | 'phrase' | 'regex' | 'op'; v: string; pos: number };
const isOp = (s: string): s is Op => (OPS as readonly string[]).includes(s);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      toks.push({ k: c, v: c, pos: i++ });
    } else if (c === '-' && (i + 1 === src.length || !/\s/.test(src[i + 1]))) {
      // A "-" negates at the start of a term; inside a word it is just a character.
      toks.push({ k: '-', v: '-', pos: i++ });
    } else if (c === '"') {
      let j = i + 1;
      let v = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        v += src[j++];
      }
      if (j >= src.length) throw new QueryError('unclosed quote', i);
      toks.push({ k: 'phrase', v, pos: i });
      i = j + 1;
    } else if (c === '/') {
      let j = i + 1;
      while (j < src.length && src[j] !== '/') j += src[j] === '\\' ? 2 : 1;
      if (j >= src.length) throw new QueryError('unclosed regular expression', i);
      const v = src.slice(i + 1, j);
      try {
        new RegExp(v);
      } catch (e) {
        throw new QueryError(`invalid regular expression: ${(e as Error).message}`, i);
      }
      toks.push({ k: 'regex', v, pos: i });
      i = j + 1;
    } else {
      let j = i;
      while (j < src.length && !/[\s()"]/.test(src[j])) {
        j++;
        // An operator ends at its colon, so "file:x" and "file:(a b)" both split there.
        if (src[j - 1] === ':' && isOp(src.slice(i, j - 1))) break;
      }
      const w = src.slice(i, j);
      if (w.endsWith(':') && isOp(w.slice(0, -1))) toks.push({ k: 'op', v: w.slice(0, -1), pos: i });
      else toks.push({ k: w === 'OR' ? 'OR' : 'word', v: w, pos: i });
      i = j;
    }
  }
  return toks;
}

export function parseQuery(src: string): Q {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const ends = (t: Tok | undefined) => !t || t.k === ')' || t.k === 'OR';

  const orExpr = (): Q => {
    const a = [andExpr()];
    while (peek()?.k === 'OR') {
      p++;
      a.push(andExpr());
    }
    return a.length === 1 ? a[0] : { t: 'or', a };
  };
  const andExpr = (): Q => {
    const a: Q[] = [];
    while (!ends(peek())) a.push(unary());
    if (!a.length) throw new QueryError('expected a search term', peek()?.pos ?? src.length);
    return a.length === 1 ? a[0] : { t: 'and', a };
  };
  const unary = (): Q => {
    if (peek()?.k !== '-') return primary();
    const dash = toks[p++];
    if (ends(peek())) throw new QueryError('"-" needs something to exclude', dash.pos);
    return { t: 'not', a: unary() };
  };
  const primary = (): Q => {
    const t = toks[p++];
    switch (t.k) {
      case '(': {
        const q = orExpr();
        if (peek()?.k !== ')') throw new QueryError('unclosed parenthesis', t.pos);
        p++;
        return q;
      }
      case 'op': {
        if (ends(peek())) throw new QueryError(`"${t.v}:" needs a value`, t.pos);
        const a = peek()?.k === '-' ? unary() : primary();
        if (t.v === 'tag' && a.t !== 'term') throw new QueryError('"tag:" takes a tag name', t.pos);
        return { t: 'op', op: t.v as Op, a };
      }
      case 'phrase':
        return { t: 'term', v: t.v, phrase: true };
      case 'regex':
        return { t: 'regex', v: t.v };
      case 'word':
        return { t: 'term', v: t.v, phrase: false };
      default:
        throw new QueryError(`unexpected "${t.v}"`, t.pos);
    }
  };

  if (!toks.length) return { t: 'and', a: [] };
  const q = orExpr();
  if (p < toks.length) throw new QueryError(`unexpected "${toks[p].v}"`, toks[p].pos);
  return q;
}

export function hasRegex(q: Q): boolean {
  if (q.t === 'regex') return true;
  if (q.t === 'and' || q.t === 'or') return q.a.some(hasRegex);
  if (q.t === 'not' || q.t === 'op') return hasRegex(q.a);
  return false;
}

/**
 * Keyword search over the user's own library: highlights and notes, brain
 * dumps, papers, recordings.
 *
 * gatherDataContext hands the model a counts-and-titles snapshot, so the
 * assistant could tell you how many papers you have but not what you
 * highlighted in them — the most obvious question to ask a reading assistant.
 *
 * BM25, roughly: term frequency saturates (a word repeated ten times is not
 * ten times as relevant) and long documents are normalized so a paper abstract
 * cannot outrank a pointed highlight. Pure and dependency-free.
 */

export type LibraryKind = 'highlight' | 'note' | 'paper' | 'recording';

export interface LibraryDoc {
  id: string;
  kind: LibraryKind;
  /** Human label for the hit — paper title, note date, article title */
  title: string;
  text: string;
  /** Where to send the user; '' when there is nowhere to go */
  url: string;
  /** Recency signal, ms epoch */
  at: number;
}

export interface LibraryHit extends LibraryDoc {
  score: number;
}

/** BM25 knobs. k1 controls term-frequency saturation, b length normalization. */
const K1 = 1.2;
const B = 0.75;

/** Words too common to discriminate between the user's own documents. */
const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'these',
  'those', 'as', 'at', 'by', 'from', 'my', 'me', 'i', 'we', 'you', 'what',
  'did', 'do', 'does', 'about', 'said', 'say',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * Rank documents against a query. Ties break toward the more recent document,
 * which is almost always what "what did I read about X" means.
 */
export function searchLibrary(
  docs: readonly LibraryDoc[],
  query: string,
  limit = 5,
): LibraryHit[] {
  const terms = tokenize(query);
  if (terms.length === 0 || docs.length === 0) return [];

  const tokens = docs.map((d) => tokenize(`${d.title} ${d.text}`));
  const lengths = tokens.map((t) => t.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / docs.length || 1;

  // Document frequency per query term
  const df = new Map<string, number>();
  for (const term of new Set(terms)) {
    df.set(term, tokens.filter((t) => t.includes(term)).length);
  }

  const hits: LibraryHit[] = [];
  for (let i = 0; i < docs.length; i++) {
    const counts = new Map<string, number>();
    for (const token of tokens[i]) counts.set(token, (counts.get(token) ?? 0) + 1);

    let score = 0;
    for (const term of terms) {
      const tf = counts.get(term) ?? 0;
      if (tf === 0) continue;
      const n = df.get(term) ?? 0;
      // +1 inside the log keeps idf positive even for a term in every document
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      const norm = tf * (K1 + 1);
      const denom = tf + K1 * (1 - B + (B * lengths[i]) / avgLength);
      score += idf * (norm / denom);
    }
    if (score > 0) hits.push({ ...docs[i], score });
  }

  return hits.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, limit);
}

/** One hit as a prompt line — kind, label, and the matching text, trimmed. */
export function formatHit(hit: LibraryHit, maxChars = 240): string {
  const text = hit.text.replace(/\s+/g, ' ').trim();
  const body = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  return `- [${hit.kind}] ${hit.title}: ${body}`;
}

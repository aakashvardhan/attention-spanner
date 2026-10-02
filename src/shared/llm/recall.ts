import { articleReaderUrl, paperOpenUrl, readerPageUrl } from '../pdf';
import type { Annotation, Paper, Settings } from '../types';
import { embed } from './ollama';
import { updateVectors } from './store';
import { cosine, dequantize, quantize } from './vectors';

/**
 * Highlight recall: semantic search over everything you have highlighted or
 * noted, plus your papers' abstracts. Finding what you already learned beats
 * re-reading for it. Local only — highlights are the most personal text here.
 */

export interface RecallEntry {
  /** Vector cache key, without the model prefix */
  key: string;
  text: string;
  /** The document it lives in */
  title: string;
  /** Reader URL that opens that document */
  url: string;
  /** What to show in a result row */
  quote: string;
  docKey: string | null;
}

/**
 * Cosine floor for "you highlighted something similar". A calibration knob,
 * not a law: nomic-embed-text puts related passages around 0.7–0.85, and a
 * different embedding model will want a different number.
 */
export const RELATED_MIN_SCORE = 0.75;

export function recallEntries(annotations: readonly Annotation[], papers: readonly Paper[]): RecallEntry[] {
  const paperTitle = new Map(papers.map((p) => [p.id, p.title]));
  const fromAnnotations = annotations
    .filter((a) => (a.text + a.note).trim() !== '')
    .map((a) => ({
      key: `annot:${a.id}`,
      text: [a.text, a.note].filter(Boolean).join('\n'),
      title: (a.paperId && paperTitle.get(a.paperId)) || docLabel(a.docUrl),
      url: a.anchor.kind === 'pdf' ? readerPageUrl(a.docUrl) : articleReaderUrl(a.docUrl),
      quote: a.text || a.note,
      docKey: a.docKey,
    }));
  const fromPapers = papers
    .filter((p) => p.abstract.trim() !== '')
    .map((p) => ({
      key: `abstract:${p.id}`,
      text: `${p.title}. ${p.abstract}`,
      title: p.title,
      url: paperOpenUrl(p),
      quote: p.abstract.slice(0, 200),
      docKey: null,
    }));
  return [...fromAnnotations, ...fromPapers];
}

function docLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : '');
  } catch {
    return url;
  }
}

const isRecallKey = (key: string) => key.includes('|annot:') || key.includes('|abstract:');
const EMBED_BATCH = 64;

/**
 * Vectors for every entry, embedding only what is not cached. Vectors for
 * deleted highlights are dropped in the same write, so the cache tracks the
 * annotations rather than growing past them.
 */
export async function recallVectors(
  entries: readonly RecallEntry[],
  settings: Pick<Settings, 'ollamaUrl' | 'ollamaEmbedModel'>,
): Promise<Map<string, Int8Array>> {
  const model = settings.ollamaEmbedModel;
  const full = (key: string) => `${model}|${key}`;
  const { aiVectors } = await chrome.storage.local.get('aiVectors');
  const cached = (aiVectors ?? {}) as Record<string, string>;
  const missing = entries.filter((e) => !cached[full(e.key)]);

  const fresh: Record<string, string> = {};
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const vectors = await embed({ url: settings.ollamaUrl, model, input: batch.map((e) => e.text) });
    batch.forEach((e, j) => (fresh[full(e.key)] = quantize(vectors[j])));
  }

  const live = new Set(entries.map((e) => full(e.key)));
  await updateVectors((current) => {
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...current, ...fresh })) {
      if (!isRecallKey(key) || live.has(key)) next[key] = value;
    }
    return next;
  });

  const all = { ...cached, ...fresh };
  const out = new Map<string, Int8Array>();
  for (const e of entries) {
    const encoded = all[full(e.key)];
    if (encoded) out.set(e.key, dequantize(encoded));
  }
  return out;
}

export async function searchRecall(
  query: string,
  entries: readonly RecallEntry[],
  settings: Pick<Settings, 'ollamaUrl' | 'ollamaEmbedModel'>,
  k: number,
): Promise<{ entry: RecallEntry; score: number }[]> {
  if (!query.trim() || entries.length === 0) return [];
  const vectors = await recallVectors(entries, settings);
  const [q] = await embed({ url: settings.ollamaUrl, model: settings.ollamaEmbedModel, input: [query] });
  return entries
    .filter((e) => vectors.has(e.key))
    .map((entry) => ({ entry, score: cosine(q, vectors.get(entry.key)!) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

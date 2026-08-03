import {
  GRAPH_TAGS_PER_NODE,
  GRAPH_TAG_BATCH,
  GRAPH_TAG_MAX_BATCHES,
  GRAPH_TAG_VOCAB_PROMPT_MAX,
} from '../constants';
import { sendMessage } from '../messages';
import { parseJsonObject } from './assistant';
import type { AssistantProvider } from './assistantTypes';
import { newTurn } from './assistantTypes';
import { hash32 } from './cache';
import { nanoProvider } from './nanoProvider';
import { providerChain, resolveRoutingEnv } from './routing';

/**
 * Topic labels for the graph, and the rules that stop twenty independent
 * batches from inventing twenty spellings of one topic.
 *
 * The convergence mechanism, in order of how much work it does:
 *   1. Batches run sequentially and the vocabulary is rebuilt between them, so
 *      batch two sees batch one's words. This is most of the fix; running them
 *      in parallel would buy half a minute and destroy it.
 *   2. Deterministic seeds (feed categories, deck and group names, venues) are
 *      already on the nodes, so batch one is never labelling a blank slate.
 *   3. canonicalizeTag snaps toward what the vocabulary already holds.
 *   4. One free sweep at the end re-snaps early batches against the vocabulary
 *      the whole run produced.
 *
 * Note for anyone extending this: brain-dump notes are deliberately absent.
 * They can be sealed with a passcode, and nothing here may put their text in
 * front of a cloud provider.
 */

export interface TagCandidate {
  id: string;
  /** Exactly the text tagInputHash covers, so the prompt and the key agree */
  text: string;
  /** Labels already on the node — deterministic, and the model should reuse them */
  seeds: string[];
}

export interface TagAssignment {
  id: string;
  tags: string[];
  tagInputHash: string;
}

export interface EnrichProgress {
  done: number;
  total: number;
}

/**
 * Five, not four: "reinforcement learning from human feedback" is a real topic
 * and a four-word cap truncates it to something that no longer matches its own
 * initialism, which is the one collapse this module most needs to get right.
 */
const TAG_MAX_WORDS = 5;
/** 48, so the five-word case above (42 characters) survives the word cap it just passed. */
const TAG_MAX_CHARS = 48;
/** Words an initialism skips — RLHF has no F for "from". */
const INITIALISM_SKIP = new Set([
  'a', 'an', 'and', 'for', 'from', 'in', 'of', 'on', 'the', 'to', 'with',
]);
/**
 * How many nodes a tag needs before the end-of-run sweep treats it as the
 * canonical spelling. Without this floor the sweep is a no-op: every tag is in
 * the vocabulary, so every tag matches itself exactly and nothing moves.
 */
const MIN_CANONICAL_COUNT = 2;

/** Bare host, matching how graphModel.ts and urlNormalize.ts read one. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * One spelling per topic. Diacritics folded, punctuation dropped, length
 * bounded — `+` and `#` survive because "c++" and "c#" are real topics.
 */
export function normalizeTag(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, TAG_MAX_WORDS)
    .join(' ')
    .slice(0, TAG_MAX_CHARS)
    .replace(/\.+$/, '')
    .trim();
}

/**
 * The minimum a thing needs to be labelled. `GraphNode` satisfies it
 * structurally, and so does a cited paper once its title and venue are put in
 * these terms — which is what lets one tagger serve both, sharing one
 * vocabulary rather than inventing a second.
 */
export interface Taggable {
  id: string;
  title: string;
  source: string;
  url: string;
  tags: string[];
  tagSource: 'auto' | 'ai' | 'manual';
  tagInputHash: string;
}

/**
 * The text a node's labels are derived from. Deliberately excludes the
 * vocabulary: fold that in and every run that learns a new word invalidates
 * every hash in the graph, which is the difference between a free re-press and
 * a bill.
 */
export function tagInputText(node: Taggable): string {
  return `${node.title}\n${node.source}\n${hostOf(node.url)}`;
}

/** Has this node's text changed since whatever labelled it last? */
export function needsTags(node: Taggable): boolean {
  if (node.tagSource === 'manual') return false;
  return node.tagInputHash !== hash32(tagInputText(node));
}

export function tagCounts(nodes: readonly { tags: string[] }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    for (const tag of new Set(n.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return counts;
}

function byCountThenName(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

/**
 * The controlled vocabulary handed to the model. Derived from the nodes rather
 * than stored, so it can never disagree with what the graph actually says.
 */
export function buildVocabulary(
  nodes: readonly { tags: string[] }[],
  max = GRAPH_TAG_VOCAB_PROMPT_MAX,
): string[] {
  return byCountThenName(tagCounts(nodes)).slice(0, max);
}

/**
 * The subset of the vocabulary the end-of-run sweep may snap *to*: labels more
 * than one node carries. A tag one early batch invented on its own is not in
 * here, which is exactly what lets the sweep move it.
 */
export function canonicalVocabulary(nodes: readonly { tags: string[] }[]): string[] {
  const counts = tagCounts(nodes);
  for (const [tag, n] of counts) if (n < MIN_CANONICAL_COUNT) counts.delete(tag);
  return byCountThenName(counts);
}

/** Words of a tag, deduped and sorted — equal for "graph neural" and "neural graph". */
function tokenKey(tag: string): string {
  return [...new Set(tag.split(' '))].sort().join(' ');
}

/**
 * First letters of a multi-word tag; '' for a single word, which has no
 * initialism. Function words are skipped because that is how people actually
 * form them — RLHF is reinforcement learning from human feedback, with no F
 * for "from".
 */
function initialsOf(tag: string): string {
  const words = tag.split(' ').filter(Boolean);
  if (words.length < 2) return '';
  const carried = words.filter((w) => !INITIALISM_SKIP.has(w));
  return (carried.length >= 2 ? carried : words).map((w) => w[0]).join('');
}

/**
 * Snap a label onto the vocabulary when they mean the same thing. Every rule
 * moves *toward* what is already there, never away, so the result is stable
 * given the same deterministic seeds and the same batch order.
 *
 * Deliberately not a stemmer: "physics" must not become "physic". A plural only
 * collapses when the singular is a word the user's own data already produced.
 */
export function canonicalizeTag(raw: string, vocab: readonly string[]): string {
  const tag = normalizeTag(raw);
  if (!tag) return '';

  const known = new Set(vocab);
  if (known.has(tag)) return tag;

  if (tag.endsWith('s') && known.has(tag.slice(0, -1))) return tag.slice(0, -1);
  if (known.has(`${tag}s`)) return `${tag}s`;

  const key = tokenKey(tag);
  for (const entry of vocab) if (tokenKey(entry) === key) return entry;

  // "RLHF" when the vocabulary spells it out, and the reverse.
  if (/^[a-z]{2,6}$/.test(tag)) {
    for (const entry of vocab) if (initialsOf(entry) === tag) return entry;
  }
  const initials = initialsOf(tag);
  if (initials.length >= 2 && known.has(initials)) return initials;

  return tag;
}

export function buildTopicPrompt(vocab: readonly string[]): string {
  const known = vocab.length
    ? `Topics already in use, most common first. Reuse one whenever it fits, exactly as spelled:\n${vocab.join(', ')}`
    : 'No topics are in use yet. You are establishing the vocabulary, so choose labels you would be happy to reuse.';

  return [
    'You label a research library by subject so related items sit together.',
    '',
    `For each numbered item, give up to ${GRAPH_TAGS_PER_NODE} topic labels.`,
    'A label is one to five lowercase words naming a field, method, or subject',
    '("diffusion models", "sqlite", "sleep research"). Never a format, a venue, a',
    'website, or a judgement — not "pdf", "arxiv", "youtube", "blog", "interesting".',
    '',
    known,
    '',
    'Reuse beats invention: two items on the same subject must get the identical',
    'label, character for character, or they will not be connected. Invent a new',
    'label only when nothing above fits. Give fewer labels rather than vague ones,',
    'and none at all if the title says nothing about its subject.',
    '',
    'Answer with JSON: {"items":[{"i":0,"tags":["..."]}]} where i is the item number.',
  ].join('\n');
}

export function buildTopicSchema(count: number): object {
  return {
    type: 'object',
    required: ['items'],
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        maxItems: count,
        items: {
          type: 'object',
          required: ['i', 'tags'],
          additionalProperties: false,
          properties: {
            i: { type: 'number', minimum: 0, maximum: Math.max(0, count - 1) },
            tags: {
              type: 'array',
              maxItems: GRAPH_TAGS_PER_NODE,
              items: { type: 'string', maxLength: TAG_MAX_CHARS },
            },
          },
        },
      },
    },
  };
}

/** The batch as the model sees it — one numbered line each, seeds included. */
export function formatBatch(batch: readonly TagCandidate[]): string {
  return batch
    .map((c, i) => {
      const line = c.text.split('\n').filter(Boolean).join(' · ');
      const seeds = c.seeds.length ? `  [already: ${c.seeds.join(', ')}]` : '';
      return `${i}. ${line}${seeds}`;
    })
    .join('\n');
}

/**
 * Read a batch reply. Keyed by the model's own `i`, never by array position:
 * a reply that skips or reorders entries then leaves those nodes untagged,
 * which the next press finishes, rather than shifting one paper's topics onto
 * the next paper — a silent, invisible, and permanent wrong answer.
 */
export function parseTopicReply(
  raw: string,
  batch: readonly TagCandidate[],
  vocab: readonly string[],
): TagAssignment[] {
  let obj: Record<string, unknown>;
  try {
    obj = parseJsonObject(raw);
  } catch {
    return [];
  }

  const items = Array.isArray(obj.items) ? obj.items : [];
  const out: TagAssignment[] = [];
  const seen = new Set<number>();

  for (const entry of items) {
    const item = entry as { i?: unknown; tags?: unknown };
    const i = typeof item.i === 'number' ? item.i : NaN;
    if (!Number.isInteger(i) || i < 0 || i >= batch.length || seen.has(i)) continue;
    seen.add(i);

    const tags = (Array.isArray(item.tags) ? item.tags : [])
      .filter((t): t is string => typeof t === 'string')
      .map((t) => canonicalizeTag(t, vocab))
      .filter(Boolean);
    const unique = [...new Set(tags)].slice(0, GRAPH_TAGS_PER_NODE);
    if (!unique.length) continue;

    out.push({ id: batch[i].id, tags: unique, tagInputHash: hash32(batch[i].text) });
  }
  return out;
}

/**
 * The free sweep. An early batch's idiosyncratic label would otherwise stick
 * forever — its input hash is unchanged, so no later run reconsiders it. Pass
 * `canonicalVocabulary`, not the full one, or every tag matches itself.
 */
export function recanonicalize(
  tagged: readonly TagAssignment[],
  vocab: readonly string[],
): TagAssignment[] {
  const out: TagAssignment[] = [];
  for (const node of tagged) {
    const next = [...new Set(node.tags.map((t) => canonicalizeTag(t, vocab)).filter(Boolean))];
    const same = next.length === node.tags.length && next.every((t, i) => t === node.tags[i]);
    if (!same) out.push({ ...node, tags: next });
  }
  return out;
}

/**
 * Label every node whose text has changed since it was last labelled. Sequential
 * by design (see the module docblock). A batch that fails leaves its nodes
 * untagged and the run continues — the button's count simply comes back smaller,
 * and pressing again finishes the job.
 */
export async function enrichTopics(
  all: readonly Taggable[],
  opts: {
    onProgress?: (p: EnrichProgress) => void;
    provider?: AssistantProvider;
    /**
     * Where the labels are written. Defaults to the graph's own nodes; the
     * citation lineage supplies its own so cited papers can be labelled without
     * a second copy of the batching, the vocabulary and the sweep.
     */
    apply?: (assignments: TagAssignment[]) => Promise<void>;
    /**
     * Extra labelled things whose words seed the vocabulary but which are not
     * themselves labelled. Passing the library here is what makes a cited paper
     * land in the same topic as the papers you already have — which is the
     * whole reason "you have already read two of these" can be said at all.
     */
    vocabularyFrom?: readonly { tags: string[] }[];
  } = {},
): Promise<EnrichProgress> {
  const apply =
    opts.apply ??
    (async (assignments: TagAssignment[]) => {
      await sendMessage({ type: 'GRAPH_SET_TAGS', assignments });
    });
  const pending = all.filter(needsTags);
  const total = Math.min(pending.length, GRAPH_TAG_BATCH * GRAPH_TAG_MAX_BATCHES);
  if (total === 0) return { done: 0, total: 0 };

  const provider =
    opts.provider ?? providerChain('extract', await resolveRoutingEnv({ nano: nanoProvider }))[0];
  if (!provider || !(await provider.available())) return { done: 0, total };

  // The working set is what makes the vocabulary grow between batches.
  const working = new Map(all.map((n) => [n.id, [...n.tags]]));
  // Borrowed words, never rewritten — keyed apart so a library tag can never be
  // mistaken for something this run assigned.
  const borrowed = (opts.vocabularyFrom ?? []).map((v) => ({ tags: v.tags }));
  const assigned = new Map<string, TagAssignment>();
  let done = 0;

  for (let b = 0; b < GRAPH_TAG_MAX_BATCHES && done < total; b++) {
    const slice = pending.slice(done, Math.min(done + GRAPH_TAG_BATCH, total));
    if (!slice.length) break;

    const vocab = buildVocabulary([
      ...[...working.values()].map((tags) => ({ tags })),
      ...borrowed,
    ]);
    const batch: TagCandidate[] = slice.map((n) => ({
      id: n.id,
      text: tagInputText(n),
      seeds: working.get(n.id) ?? [],
    }));

    try {
      const reply = await provider.generate({
        system: buildTopicPrompt(vocab),
        turns: [newTurn('user', formatBatch(batch))],
        responseSchema: buildTopicSchema(batch.length),
      });
      const assignments = parseTopicReply(reply.text, batch, vocab);
      if (assignments.length) {
        for (const a of assignments) {
          working.set(a.id, a.tags);
          assigned.set(a.id, a);
        }
        await apply(assignments);
      }
    } catch {
      // This batch stays untagged; the count comes back smaller and the next
      // press picks it up. One flaky call must not abandon the other eleven.
    }

    done += slice.length;
    opts.onProgress?.({ done, total });
  }

  const swept = recanonicalize(
    [...assigned.values()],
    canonicalVocabulary([...[...working.values()].map((tags) => ({ tags })), ...borrowed]),
  );
  if (swept.length) await apply(swept);

  return { done, total };
}

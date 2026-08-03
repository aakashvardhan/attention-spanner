import { describe, expect, it } from 'vitest';
import { GRAPH_TAGS_PER_NODE } from '../constants';
import type { GraphNode } from '../types';
import { hash32 } from './cache';
import {
  buildVocabulary,
  canonicalVocabulary,
  canonicalizeTag,
  enrichTopics,
  needsTags,
  normalizeTag,
  parseTopicReply,
  recanonicalize,
  tagInputText,
  type TagCandidate,
} from './topics';

const NOW = 1_700_000_000_000;

function node(over: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'a',
    kind: 'article',
    title: 'Attention Is All You Need',
    url: 'https://arxiv.org/abs/1706.03762',
    source: 'arXiv',
    tags: [],
    tagSource: 'auto',
    tagInputHash: '',
    completion: 0,
    firstSeenAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function candidates(...ids: string[]): TagCandidate[] {
  return ids.map((id) => ({ id, text: `${id} title`, seeds: [] }));
}

describe('normalizeTag', () => {
  // "RLHF", "rlhf." and " RLHF " are three tags and therefore zero edges —
  // every node that shares the topic ends up in a different bucket.
  it('collapses case, punctuation and whitespace to one spelling', () => {
    expect(normalizeTag('  Diffusion   Models. ')).toBe('diffusion models');
    expect(normalizeTag('Diffusion-Models')).toBe('diffusion models');
    expect(normalizeTag('DIFFUSION MODELS')).toBe('diffusion models');
  });

  it('folds diacritics so "Bayes" and "Bayés" are one topic', () => {
    expect(normalizeTag('Bayés')).toBe('bayes');
  });

  // "c++" and "c#" are real topics and the obvious strip-all-punctuation rule
  // turns both into "c", merging two languages into one meaningless label.
  it('keeps the punctuation that is part of a name', () => {
    expect(normalizeTag('C++')).toBe('c++');
    expect(normalizeTag('C#')).toBe('c#');
  });

  it('bounds length so a sentence cannot become a tag', () => {
    expect(normalizeTag('a study of the long term effects of sleep').split(' ')).toHaveLength(5);
  });

  // A four-word cap truncates this to "reinforcement learning from human",
  // whose initials are rlfh — so it no longer matches its own initialism, and
  // the one collapse this module most needs to make silently stops working.
  it('keeps a five-word topic whole', () => {
    expect(normalizeTag('Reinforcement Learning from Human Feedback')).toBe(
      'reinforcement learning from human feedback',
    );
  });

  it('returns empty for a label with nothing in it', () => {
    expect(normalizeTag('  ...  ')).toBe('');
  });
});

describe('canonicalizeTag', () => {
  // The single case this whole mechanism exists for.
  it('maps an initialism onto the spelled-out entry already in use', () => {
    const vocab = ['reinforcement learning from human feedback'];

    expect(canonicalizeTag('RLHF', vocab)).toBe('reinforcement learning from human feedback');
  });

  it('maps a spelled-out label onto an initialism already in use', () => {
    expect(canonicalizeTag('reinforcement learning from human feedback', ['rlhf'])).toBe('rlhf');
  });

  it('maps a plural onto a singular the vocabulary already has', () => {
    expect(canonicalizeTag('transformers', ['transformer'])).toBe('transformer');
  });

  // Blind stemming invents words: "physics" is not the plural of anything, and
  // a stemmer that produces "physic" has silently created a topic nobody uses.
  it('leaves a plural alone when the singular is not a word in use', () => {
    expect(canonicalizeTag('physics', ['neuroscience'])).toBe('physics');
  });

  it('matches the same words in a different order', () => {
    expect(canonicalizeTag('neural graph networks', ['graph neural networks'])).toBe(
      'graph neural networks',
    );
  });

  // Over-eager snapping is the opposite failure and it is worse, because it
  // merges genuinely distinct topics and nothing downstream can tell.
  it('leaves an unrecognised label unchanged', () => {
    expect(canonicalizeTag('sleep research', ['diffusion models', 'rlhf'])).toBe('sleep research');
  });

  it('normalizes before matching, so casing never blocks a snap', () => {
    expect(canonicalizeTag('  Diffusion Models ', ['diffusion models'])).toBe('diffusion models');
  });
});

describe('buildVocabulary', () => {
  it('orders by how many nodes carry each label, then alphabetically', () => {
    const nodes = [
      { tags: ['rlhf', 'transformers'] },
      { tags: ['rlhf'] },
      { tags: ['rlhf', 'sleep'] },
      { tags: ['transformers'] },
    ];

    expect(buildVocabulary(nodes)).toEqual(['rlhf', 'transformers', 'sleep']);
  });

  it('counts a node once even when it repeats a label', () => {
    expect(buildVocabulary([{ tags: ['rlhf', 'rlhf'] }, { tags: ['sleep'] }])).toEqual([
      'rlhf',
      'sleep',
    ]);
  });

  it('caps at the prompt budget so the vocabulary stays affordable in every batch', () => {
    const nodes = Array.from({ length: 100 }, (_, i) => ({ tags: [`topic ${i}`] }));

    expect(buildVocabulary(nodes, 10)).toHaveLength(10);
  });
});

describe('canonicalVocabulary', () => {
  // Without this floor the end-of-run sweep is a no-op: every tag is in the
  // full vocabulary, so every tag matches itself exactly and nothing moves.
  it('excludes labels only one node carries', () => {
    const nodes = [{ tags: ['rlhf'] }, { tags: ['rlhf'] }, { tags: ['one off'] }];

    expect(canonicalVocabulary(nodes)).toEqual(['rlhf']);
  });
});

describe('parseTopicReply', () => {
  const batch = candidates('a', 'b', 'c');

  it('assigns tags to the node the model indexed, not the array position', () => {
    const raw = JSON.stringify({ items: [{ i: 2, tags: ['sleep'] }] });

    expect(parseTopicReply(raw, batch, [])).toEqual([
      { id: 'c', tags: ['sleep'], tagInputHash: hash32('c title') },
    ]);
  });

  // A reply that skips an entry must leave that node untagged for the next
  // press. Shifting by position puts paper A's topics on paper B — a wrong
  // answer that is silent, invisible, and permanent.
  it('leaves a skipped entry untagged rather than shifting the ones after it', () => {
    const raw = JSON.stringify({
      items: [
        { i: 0, tags: ['rlhf'] },
        { i: 2, tags: ['sleep'] },
      ],
    });

    expect(parseTopicReply(raw, batch, []).map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('ignores an index outside the batch and a repeated one', () => {
    const raw = JSON.stringify({
      items: [
        { i: 9, tags: ['rlhf'] },
        { i: 0, tags: ['rlhf'] },
        { i: 0, tags: ['sleep'] },
      ],
    });

    expect(parseTopicReply(raw, batch, [])).toEqual([
      { id: 'a', tags: ['rlhf'], tagInputHash: hash32('a title') },
    ]);
  });

  it('drops blank labels and caps how many a node keeps', () => {
    const raw = JSON.stringify({
      items: [{ i: 0, tags: ['rlhf', '  ', 'sleep', 'diffusion', 'transformers'] }],
    });

    expect(parseTopicReply(raw, batch, [])[0].tags).toHaveLength(GRAPH_TAGS_PER_NODE);
  });

  it('drops a node whose labels were all junk rather than storing an empty set', () => {
    expect(parseTopicReply(JSON.stringify({ items: [{ i: 0, tags: ['...'] }] }), batch, [])).toEqual(
      [],
    );
  });

  // This is the entire convergence mechanism. If the reply is stored verbatim,
  // the vocabulary handed to the model does nothing at all.
  it('canonicalizes every label against the vocabulary it was given', () => {
    const raw = JSON.stringify({ items: [{ i: 0, tags: ['RLHF'] }] });

    expect(parseTopicReply(raw, batch, ['reinforcement learning from human feedback'])[0].tags)
      .toEqual(['reinforcement learning from human feedback']);
  });

  it('returns nothing on junk rather than throwing', () => {
    expect(parseTopicReply('sorry, I cannot do that', batch, [])).toEqual([]);
    expect(parseTopicReply(JSON.stringify({ items: 'nope' }), batch, [])).toEqual([]);
  });
});

describe('needsTags', () => {
  // An idempotency key that re-labels everything on every press is a bill.
  it('is false once a node carries the hash of its own text', () => {
    const n = node();

    expect(needsTags({ ...n, tagInputHash: hash32(tagInputText(n)) })).toBe(false);
  });

  it('is true again once the title changes', () => {
    const n = node();
    const tagged = { ...n, tagInputHash: hash32(tagInputText(n)) };

    expect(needsTags({ ...tagged, title: 'A Different Paper' })).toBe(true);
  });

  it('leaves user-owned labels alone', () => {
    expect(needsTags({ ...node(), tagSource: 'manual', tags: ['sleep research'] })).toBe(false);
  });

  // The vocabulary grows on every run. Fold it into the hashed text and every
  // run invalidates every node in the graph.
  it('hashes only the node, so a growing vocabulary never invalidates it', () => {
    expect(tagInputText(node())).not.toContain('rlhf');
    expect(tagInputText(node({ tags: ['rlhf'] }))).toBe(tagInputText(node()));
  });
});

describe('enrichTopics', () => {
  /** A provider that answers every batch with one fixed label. */
  const scripted = (label: string) =>
    ({
      id: 'nano' as const,
      available: async () => true,
      generate: async (req: { turns: { text: string }[] }) => {
        // Reply for every item in the batch, keyed by index.
        const lines = req.turns[0].text.split('\n').filter((l) => /^\d+\./.test(l));
        return {
          text: JSON.stringify({ items: lines.map((_, i) => ({ i, tags: [label] })) }),
        };
      },
    }) as unknown as Parameters<typeof enrichTopics>[1] extends { provider?: infer P }
      ? NonNullable<P>
      : never;

  const item = (id: string, title: string) => ({
    id,
    title,
    source: '',
    url: '',
    tags: [],
    tagSource: 'auto' as const,
    tagInputHash: '',
  });

  // The seam Part 3 depends on: a second caller has to be able to write its
  // labels somewhere other than the graph's own nodes.
  it('routes assignments through the supplied apply, not the graph', async () => {
    const written: string[] = [];
    await enrichTopics([item('a', 'A paper about sleep')], {
      provider: scripted('sleep research'),
      apply: async (assignments) => {
        written.push(...assignments.map((x) => `${x.id}:${x.tags.join('|')}`));
      },
    });

    expect(written).toContain('a:sleep research');
  });

  // Cited papers must land under the same headings as the library, or "you
  // already have two of these" cannot be said.
  it('borrows vocabulary from things it is not labelling', async () => {
    const written: string[] = [];
    await enrichTopics([item('a', 'Something about RLHF')], {
      // The model answers with the initialism; the library spells it out.
      provider: scripted('RLHF'),
      vocabularyFrom: [
        { tags: ['reinforcement learning from human feedback'] },
        { tags: ['reinforcement learning from human feedback'] },
      ],
      apply: async (assignments) => {
        written.push(...assignments.map((x) => x.tags.join('|')));
      },
    });

    expect(written[0]).toBe('reinforcement learning from human feedback');
  });

  it('does nothing when everything is already labelled', async () => {
    let called = false;
    const labelled = { ...item('a', 'A paper'), tagInputHash: hash32(tagInputText(item('a', 'A paper'))) };
    const result = await enrichTopics([labelled], {
      provider: scripted('x'),
      apply: async () => {
        called = true;
      },
    });

    expect(result).toEqual({ done: 0, total: 0 });
    expect(called).toBe(false);
  });
});

describe('recanonicalize', () => {
  // An early batch's idiosyncratic label would otherwise stick forever: its
  // input hash is unchanged, so no later run ever reconsiders it.
  it('repairs an early label once a later batch established the common form', () => {
    const tagged = [
      { id: 'a', tags: ['rlhf'], tagInputHash: 'h1' },
      { id: 'b', tags: ['reinforcement learning from human feedback'], tagInputHash: 'h2' },
      { id: 'c', tags: ['reinforcement learning from human feedback'], tagInputHash: 'h3' },
    ];

    expect(recanonicalize(tagged, canonicalVocabulary(tagged))).toEqual([
      { id: 'a', tags: ['reinforcement learning from human feedback'], tagInputHash: 'h1' },
    ]);
  });

  it('returns nothing when every label is already canonical', () => {
    const tagged = [
      { id: 'a', tags: ['rlhf'], tagInputHash: 'h1' },
      { id: 'b', tags: ['rlhf'], tagInputHash: 'h2' },
    ];

    expect(recanonicalize(tagged, canonicalVocabulary(tagged))).toEqual([]);
  });

  it('keeps the input hash so a repaired node is not queued for re-labelling', () => {
    const tagged = [
      { id: 'a', tags: ['transformers'], tagInputHash: 'h1' },
      { id: 'b', tags: ['transformer'], tagInputHash: 'h2' },
      { id: 'c', tags: ['transformer'], tagInputHash: 'h3' },
    ];

    expect(recanonicalize(tagged, canonicalVocabulary(tagged))[0]).toMatchObject({
      id: 'a',
      tagInputHash: 'h1',
    });
  });
});

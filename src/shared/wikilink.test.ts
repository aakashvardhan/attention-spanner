import { describe, expect, it } from 'vitest';
import type { EdgeReason } from './graphModel';
import type { GraphNode } from './types';
import {
  linkMention,
  mentionIndex,
  noteEdges,
  parseWikiLinks,
  resolveWikiLink,
  unlinkedMentions,
} from './wikilink';

const NOW = 1_700_000_000_000;

function node(id: string, title: string): GraphNode {
  return {
    id,
    kind: 'paper',
    title,
    url: `https://example.com/${id}`,
    source: '',
    tags: [],
    tagSource: 'auto',
    tagInputHash: '',
    completion: 0,
    firstSeenAt: NOW,
    updatedAt: NOW,
  };
}

function edgesFrom(text: string, nodes: GraphNode[]) {
  const out: { b: string; reason: EdgeReason }[] = [];
  noteEdges([{ id: 'note:1', text }], nodes, (_a, b, reason) => out.push({ b, reason }));
  return out;
}

describe('parseWikiLinks', () => {
  it('finds every target and deduplicates them', () => {
    const text = 'Building on [[Attention Is All You Need]] and [[DDPM]], plus [[DDPM]] again.';

    expect(parseWikiLinks(text)).toEqual(['Attention Is All You Need', 'DDPM']);
  });

  // An unclosed bracket must not swallow the rest of the note as one target.
  it('ignores an unclosed link', () => {
    expect(parseWikiLinks('I meant to write [[something but never closed it')).toEqual([]);
  });

  it('ignores an empty link', () => {
    expect(parseWikiLinks('[[]] and [[   ]]')).toEqual([]);
  });
});

describe('resolveWikiLink', () => {
  const nodes = [node('a', 'Attention Is All You Need'), node('b', 'Denoising Diffusion')];

  it('matches ignoring case and punctuation', () => {
    expect(resolveWikiLink('attention is all you need!', nodes)?.id).toBe('a');
  });

  it('resolves a unique prefix', () => {
    expect(resolveWikiLink('Denoising', nodes)?.id).toBe('b');
  });

  // Silently pointing at the wrong paper is both wrong and invisible. An
  // unresolved link at least says something is missing.
  it('refuses an ambiguous prefix rather than guessing', () => {
    const both = [node('a', 'Diffusion Models One'), node('b', 'Diffusion Models Two')];

    expect(resolveWikiLink('Diffusion Models', both)).toBe(null);
  });

  it('returns null for a target nothing matches', () => {
    expect(resolveWikiLink('A Paper I Never Saved', nodes)).toBe(null);
  });
});

describe('mentionIndex', () => {
  // A node titled "Attention" appears inside nearly every note about machine
  // learning, and the real mentions would be buried under the accidents.
  it('excludes titles too short to match on safely', () => {
    const index = mentionIndex([node('a', 'Attention'), node('b', 'Denoising Diffusion Models')]);

    expect([...index.values()].map((n) => n.id)).toEqual(['b']);
  });
});

describe('unlinkedMentions', () => {
  const nodes = [node('a', 'Denoising Diffusion Models'), node('b', 'Speculative Decoding Fast')];
  const index = mentionIndex(nodes);

  it('finds a node the note names without linking it', () => {
    const note = { id: 'n1', text: 'I keep coming back to denoising diffusion models lately.' };

    expect(unlinkedMentions(note, index, new Set()).map((n) => n.id)).toEqual(['a']);
  });

  // Connecting something has to make the graph tidier, not add a second
  // relationship beside the one just created.
  it('says nothing about a pair that is already linked', () => {
    const note = { id: 'n1', text: 'About [[Denoising Diffusion Models]] again.' };

    expect(unlinkedMentions(note, index, new Set(['a']))).toEqual([]);
  });

  it('caps how many one note can name', () => {
    const many = Array.from({ length: 10 }, (_, i) => node(`n${i}`, `A Long Enough Title ${i}`));
    const text = many.map((n) => n.title).join(' and ');
    const found = unlinkedMentions({ id: 'x', text }, mentionIndex(many), new Set(), 3);

    expect(found).toHaveLength(3);
  });
});

describe('linkMention', () => {
  it('wraps the first occurrence, preserving what the user typed', () => {
    expect(linkMention('More on Denoising Diffusion Models today.', 'denoising diffusion models')).toBe(
      'More on [[Denoising Diffusion Models]] today.',
    );
  });

  it('leaves the text alone when the title is not there', () => {
    expect(linkMention('Nothing relevant here.', 'Some Paper')).toBe('Nothing relevant here.');
  });
});

describe('noteEdges', () => {
  const nodes = [node('a', 'Denoising Diffusion Models')];

  it('emits an asserted link at full strength', () => {
    expect(edgesFrom('See [[Denoising Diffusion Models]].', nodes)).toEqual([
      { b: 'a', reason: 'link' },
    ]);
  });

  it('emits a weaker mention when the note only names it', () => {
    expect(edgesFrom('Thinking about denoising diffusion models.', nodes)).toEqual([
      { b: 'a', reason: 'mention' },
    ]);
  });

  it('emits one edge, not two, when a note both links and names something', () => {
    const text = 'Denoising Diffusion Models — see [[Denoising Diffusion Models]].';

    expect(edgesFrom(text, nodes)).toEqual([{ b: 'a', reason: 'link' }]);
  });

  // A red link is a real state: it points at something not in the library yet.
  it('emits nothing for a link that resolves to no node', () => {
    expect(edgesFrom('See [[A Paper I Have Not Saved]].', nodes)).toEqual([]);
  });
});

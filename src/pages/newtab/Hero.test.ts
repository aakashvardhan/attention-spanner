import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EditionName, editionName, greetingFor } from './Hero';
import { QUOTES, quoteOfDay } from './quotes';

describe('greetingFor', () => {
  it('changes on the hour boundaries, not around them', () => {
    expect(greetingFor(0)).toBe('Up late?');
    expect(greetingFor(4)).toBe('Up late?');
    expect(greetingFor(5)).toBe('Good morning');
    expect(greetingFor(11)).toBe('Good morning');
    expect(greetingFor(12)).toBe('Good afternoon');
    expect(greetingFor(17)).toBe('Good afternoon');
    expect(greetingFor(18)).toBe('Good evening');
    expect(greetingFor(23)).toBe('Good evening');
  });
});

describe('quoteOfDay', () => {
  it('holds steady for a whole day', () => {
    expect(quoteOfDay('2026-09-15')).toBe(quoteOfDay('2026-09-15'));
  });

  it('moves on the next day', () => {
    expect(quoteOfDay('2026-09-15')).not.toBe(quoteOfDay('2026-09-16'));
  });

  it('always lands inside the list, across a full cycle and beyond', () => {
    const start = Date.parse('2026-09-15T00:00:00Z');
    for (let day = 0; day < QUOTES.length * 2; day++) {
      const date = new Date(start + day * 86_400_000).toISOString().slice(0, 10);
      expect(QUOTES).toContain(quoteOfDay(date));
    }
  });

  it('does not index negatively before the epoch', () => {
    expect(QUOTES).toContain(quoteOfDay('1969-07-20'));
  });
});

describe('editionName', () => {
  it('follows the same hour boundaries as the greeting', () => {
    expect(editionName(0)).toBe('The Late Edition');
    expect(editionName(4)).toBe('The Late Edition');
    expect(editionName(5)).toBe('The Morning Edition');
    expect(editionName(11)).toBe('The Morning Edition');
    expect(editionName(12)).toBe('The Afternoon Edition');
    expect(editionName(17)).toBe('The Afternoon Edition');
    expect(editionName(18)).toBe('The Evening Edition');
    expect(editionName(23)).toBe('The Evening Edition');
  });
});

describe('EditionName', () => {
  const html = renderToStaticMarkup(createElement(EditionName, { name: 'The Late Edition' }));

  it('reads as one name to a screen reader, not letter by letter', () => {
    expect(html).toMatch(/^<h1 class="edition-name" aria-label="The Late Edition"><span class="edition-name-line" aria-hidden="true">/);
  });

  it('sets one indexed span per letter for the hover wave', () => {
    const letters = [...html.matchAll(/<span style="--i:(\d+)">(.)<\/span>/g)];
    expect(letters.map((m) => m[2]).join('')).toBe('The Late Edition');
    expect(letters.map((m) => Number(m[1]))).toEqual([...Array(16).keys()]);
  });
});

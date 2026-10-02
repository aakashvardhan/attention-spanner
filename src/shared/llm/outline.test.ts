import { describe, expect, it } from 'vitest';
import { parseOutline } from './outline';

describe('parseOutline', () => {
  it('takes each bullet and its first page citation', () => {
    const md = [
      '- **Problem:** recurrence is slow to train [1]',
      '* The Transformer uses attention only [2][3]',
      '1. Beats prior BLEU scores [8, 9]',
    ].join('\n');
    expect(parseOutline(md, 10)).toEqual([
      { text: 'Problem: recurrence is slow to train', page: 1 },
      { text: 'The Transformer uses attention only', page: 2 },
      { text: 'Beats prior BLEU scores', page: 8 },
    ]);
  });

  it('keeps a bullet whose page is missing or out of range, without a jump', () => {
    expect(parseOutline('- Limits are discussed [42]\n- No citation here', 12)).toEqual([
      { text: 'Limits are discussed', page: null },
      { text: 'No citation here', page: null },
    ]);
  });

  it('ignores preamble and blank lines', () => {
    expect(parseOutline('Here is the outline:\n\n- One point [1]', 3)).toEqual([
      { text: 'One point', page: 1 },
    ]);
  });
});

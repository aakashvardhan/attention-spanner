import { describe, expect, it } from 'vitest';
import { captionKey, MENTION_RE, mentionKey } from './figures';

describe('captionKey', () => {
  it('reads colon captions as strong', () => {
    expect(captionKey('Figure 3: Overview of the model.')).toEqual({ key: 'figure:3', strong: true });
    expect(captionKey('Table 2: Results on GLUE')).toEqual({ key: 'table:2', strong: true });
    expect(captionKey('Fig. 4: Ablation')).toEqual({ key: 'figure:4', strong: true });
  });

  it('accepts a full stop only when caption text follows', () => {
    expect(captionKey('Figure 5. Attention maps for layer 4')).toEqual({ key: 'figure:5', strong: false });
    expect(captionKey('Figure 5.')).toBeNull();
  });

  it('ignores mentions that do not open the line', () => {
    expect(captionKey('as shown in Figure 3: the loss')).toBeNull();
    expect(captionKey('Figures are shown below')).toBeNull();
  });
});

describe('mentions', () => {
  const keys = (text: string) => [...text.matchAll(MENTION_RE)].map((m) => mentionKey(m[1], m[2]));

  it('finds every common spelling', () => {
    expect(keys('see Figure 3, Fig. 4, Figs. 5 and Table 2 (Tab. 7)')).toEqual([
      'figure:3',
      'figure:4',
      'figure:5',
      'table:2',
      'table:7',
    ]);
  });

  it('skips words that merely start the same way', () => {
    expect(keys('Tablet 3 and Figurative 2')).toEqual([]);
  });
});

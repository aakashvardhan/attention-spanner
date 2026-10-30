import { describe, expect, it } from 'vitest';
import { visibleRows } from './visibleRows';

const items = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('visibleRows', () => {
  it('shows a short list whole', () => {
    expect(visibleRows(items(3), false)).toEqual({ shown: [0, 1, 2], hidden: 0 });
  });

  it('caps a long list at five and counts the rest', () => {
    expect(visibleRows(items(7), false)).toEqual({ shown: [0, 1, 2, 3, 4], hidden: 2 });
  });

  it('shows everything once expanded', () => {
    expect(visibleRows(items(7), true)).toEqual({ shown: items(7), hidden: 0 });
  });

  it('handles an empty list', () => {
    expect(visibleRows([], false)).toEqual({ shown: [], hidden: 0 });
  });

  it('limit 0 shows none and hides all', () => {
    expect(visibleRows(items(4), false, 0)).toEqual({ shown: [], hidden: 4 });
  });
});

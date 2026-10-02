import { describe, expect, it } from 'vitest';
import { verifyCitations } from './AiNote';

describe('verifyCitations', () => {
  it('keeps markers for passages the model was given and drops invented ones', () => {
    // Passages 0 and 4 were sent, so [1] and [5] are real; [9] was never shown.
    const out = verifyCitations('Loss falls [1]. It plateaus [9]. Then rises [5].', [0, 4]);
    expect(out.text).toBe('Loss falls [1]. It plateaus. Then rises [5].');
    expect(out.cited).toEqual([1, 5]);
  });

  it('lists each source once, in order', () => {
    expect(verifyCitations('a [3] b [1] c [3]', [0, 2]).cited).toEqual([1, 3]);
  });

  it('offers nothing to click for a cached answer, whose passages are unknown', () => {
    expect(verifyCitations('a [1]', []).cited).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { cosine, dequantize, quantize, topK } from './vectors';

const random = (seed: number, n = 768) =>
  Array.from({ length: n }, (_, i) => Math.sin(seed * 9301 + i * 49297) * 0.5);

describe('int8 vectors', () => {
  it('round-trips through base64 at the same length', () => {
    expect(dequantize(quantize(random(1))).length).toBe(768);
  });

  it('keeps cosine similarity within 0.01 of the float original', () => {
    for (const [a, b] of [[1, 2], [3, 4], [5, 5]]) {
      const exact = cosine(random(a), random(b));
      const approx = cosine(dequantize(quantize(random(a))), dequantize(quantize(random(b))));
      expect(Math.abs(exact - approx)).toBeLessThan(0.01);
    }
  });

  it('ranks the nearest vector first', () => {
    const query = [1, 0, 0];
    expect(topK(query, [[0, 1, 0], [0.9, 0.1, 0], [-1, 0, 0]], 2)).toEqual([1, 0]);
  });

  it('scores a zero vector as unrelated instead of NaN', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

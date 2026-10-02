/**
 * Embeddings, small enough for chrome.storage.local.
 *
 * A 768-float vector as JSON is ~8 KB; normalised and quantised to int8 it is
 * 768 bytes, ~1 KB as base64. Cosine similarity survives the rounding to well
 * within what ranking needs (vectors.test.ts pins that).
 */

export function quantize(vector: number[]): string {
  const norm = Math.hypot(...vector) || 1;
  const bytes = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    bytes[i] = Math.max(-127, Math.min(127, Math.round((vector[i] / norm) * 127)));
  }
  let binary = '';
  for (const byte of new Uint8Array(bytes.buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function dequantize(encoded: string): Int8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int8Array(bytes.buffer);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Indices of the `k` vectors closest to `query`, best first. */
export function topK(query: ArrayLike<number>, vectors: ArrayLike<number>[], k: number): number[] {
  return vectors
    .map((vector, index) => ({ index, score: cosine(query, vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((hit) => hit.index);
}

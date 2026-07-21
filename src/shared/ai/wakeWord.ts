/**
 * "Hey Jarvis" wake-word matching over speech-to-text transcripts.
 * Dependency-free and pure, like fuzzy.ts — but STT errors are phonetic
 * ("travis", "jervis"), which substring scoring can't catch, so this uses
 * edit distance plus a curated variant list.
 */

const WAKE_TARGET = 'jarvis';

/** Common STT misrecognitions accepted outright */
const WAKE_VARIANTS = new Set(['jarvis', 'jervis', 'jarvus', 'jarves', 'jarvas']);

/** Everyday words STT swaps in for "jarvis" — need the hey-prefix to count */
const LOOKALIKES = new Set(['travis', 'davis', 'jervais', 'gervais']);

/** Words that count as the "hey" prefix */
const HEY_WORDS = new Set(['hey', 'hay', 'a', 'ok', 'okay']);

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Find the wake word in a transcript.
 * Returns the command text spoken after it, '' if the wake word was said
 * alone, or null if the transcript doesn't contain it.
 *
 * Curated variants and close matches (distance ≤ 1, e.g. "jervis") work
 * bare; farther lookalikes ("travis", "davis") are everyday words and only
 * count when preceded by hey/ok — otherwise every mention of a Travis
 * would wake us.
 */
export function matchWakeWord(transcript: string): string | null {
  const words = transcript
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const bareHit = WAKE_VARIANTS.has(word) || levenshtein(word, WAKE_TARGET) <= 1;
    const hasHey = i > 0 && HEY_WORDS.has(words[i - 1]);
    const heyHit = hasHey && (LOOKALIKES.has(word) || levenshtein(word, WAKE_TARGET) === 2);
    if (bareHit || heyHit) return words.slice(i + 1).join(' ');
  }
  return null;
}

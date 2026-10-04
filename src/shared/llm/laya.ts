/**
 * Decisions from Laya, a local "System 1" model served by
 * scripts/laya-server (localhost:11435). It never writes text: it answers
 * typed questions about a state with calibrated probabilities, in ~150ms.
 * That makes it the right tool where the alternative is a cosine threshold or
 * a generative prompt asked to pick a label — and the probability is what lets
 * a wrong suggestion stay quiet instead of nagging.
 *
 * Local by construction, so it does not go through route.ts. Off when
 * settings.layaUrl is ''.
 */

export type LayaQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> | string[] }
  /** criteria are ordered levels, index 0 = lowest */
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } };

export type LayaAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number> }
  /** score is the expected level, 0..levels-1 */
  | { type: 'score'; score: number; probabilities: Record<string, number> }
  /** P(true) */
  | { type: 'noul'; noul: number };

export type LayaHealth = { ok: true; ready: boolean } | { ok: false };

const base = (url: string) => url.replace(/\/+$/, '');

export async function layaHealth(url: string): Promise<LayaHealth> {
  try {
    const res = await fetch(`${base(url)}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { ready?: boolean };
    return { ok: true, ready: body.ready === true };
  } catch {
    return { ok: false };
  }
}

let readyMemo: { url: string; at: number; ready: boolean } | null = null;

/** Probed at most every 20s per page, so a feature can ask on every render. */
export async function layaReady(url: string): Promise<boolean> {
  if (!url) return false;
  if (readyMemo && readyMemo.url === url && Date.now() - readyMemo.at < 20_000) return readyMemo.ready;
  const h = await layaHealth(url);
  readyMemo = { url, at: Date.now(), ready: h.ok && h.ready };
  return readyMemo.ready;
}

/** Every question in one call is answered in one batched forward pass. */
export async function systemOne<K extends string>(
  url: string,
  state: unknown,
  questions: Partial<Record<K, LayaQuestion>>,
  signal?: AbortSignal,
): Promise<Partial<Record<K, LayaAnswer>>> {
  const res = await fetch(`${base(url)}/systemOne`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, questions }),
    signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Laya answered ${res.status}.`);
  }
  const body = (await res.json()) as { answers: Partial<Record<K, LayaAnswer>> };
  return body.answers;
}

/**
 * The answer only if Laya is at least `min` sure of it, else null.
 * choice → the option; noul → true/false; score → the most likely level index.
 */
export function confident(answer: LayaAnswer | undefined, min: number): string | boolean | number | null {
  if (!answer) return null;
  if (answer.type === 'noul') {
    if (answer.noul >= min) return true;
    if (1 - answer.noul >= min) return false;
    return null;
  }
  if (answer.type === 'choice') {
    return (answer.probabilities[answer.choice] ?? 0) >= min ? answer.choice : null;
  }
  let best: string | null = null;
  for (const [level, p] of Object.entries(answer.probabilities)) {
    if (p >= min && (best === null || p > answer.probabilities[best])) best = level;
  }
  return best === null ? null : Number(best);
}

/**
 * Laya keeps the first 512 tokens of a state. Cut long text here, at a word,
 * so what gets dropped is the end and not a field the question depends on.
 * ~4 chars per token; a calibration knob, not a tokenizer.
 */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const space = cut.lastIndexOf(' ');
  return `${space > maxChars * 0.8 ? cut.slice(0, space) : cut}…`;
}

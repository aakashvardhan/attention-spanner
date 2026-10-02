import { LOCAL_CONTEXT_CHARS } from '../constants';
import { getSettings } from '../storage';
import type { Settings } from '../types';
import { claudeStream } from './claude';
import { chat, embed, health, type Health } from './ollama';
import { route, type AiSource, type AiTask, type Route } from './route';
import { cacheGet, cachePut, hashText, recordStat } from './store';
import { topK } from './vectors';

/**
 * One AI call, start to finish: pick a route, cut the document down if the
 * local model needs it, run it, cache it, time it. Split in two (`plan`, then
 * `run`) so the UI can stop between them and ask before anything goes to the
 * cloud.
 */

export interface AiRequest {
  task: AiTask;
  source: AiSource;
  system: string;
  /**
   * The document as passages: paragraphs, PDF pages or transcript blocks.
   * Retrieval picks among them, and `numbered` labels them [1]..[n] (by their
   * index in this array) so an answer can cite them.
   */
  passages: string[];
  numbered?: boolean;
  prompt: string;
  /** Present = cache the result under task:cacheKey */
  cacheKey?: string;
}

export interface AiPlan {
  route: Route;
  settings: Settings;
}

export interface AiResult {
  text: string;
  route: Route;
  /** Model that actually answered, for the provenance chip */
  model: string;
  /** Passage indices that were sent; a citation outside this set is invented */
  sent: number[];
  cached: boolean;
}

let passageMemo: { key: string; vectors: number[][] } | null = null;
let healthMemo: { url: string; at: number; value: Health } | null = null;

/** Health is probed at most every 20s per page — a new tab must not hit localhost per render. */
async function ollamaHealth(url: string): Promise<Health> {
  if (healthMemo && healthMemo.url === url && Date.now() - healthMemo.at < 20_000) {
    return healthMemo.value;
  }
  const value = await health(url);
  healthMemo = { url, at: Date.now(), value };
  return value;
}

export async function planAi(request: AiRequest): Promise<AiPlan> {
  const settings = await getSettings();
  const up = await ollamaHealth(settings.ollamaUrl);
  const chars = request.passages.reduce((sum, p) => sum + p.length, 0);
  return {
    settings,
    route: route(
      { task: request.task, source: request.source, chars },
      {
        ollamaUp: up.ok,
        hasLocalModel: settings.ollamaChatModel !== '',
        online: navigator.onLine,
        cloudMode: settings.cloudMode,
        hasKey: settings.claudeKey !== '',
      },
    ),
  };
}

export async function cachedAi(request: AiRequest): Promise<AiResult | null> {
  if (!request.cacheKey) return null;
  const hit = await cacheGet(`${request.task}:${request.cacheKey}`);
  if (!hit) return null;
  const route: Route =
    hit.target === 'claude'
      ? { target: 'claude', model: hit.model, confirm: false, reason: 'Saved answer' }
      : { target: 'ollama', retrieval: false, reason: 'Saved answer' };
  return { text: hit.text, route, model: hit.model, sent: [], cached: true };
}

export async function runAi(
  request: AiRequest,
  plan: AiPlan,
  opts: { signal?: AbortSignal; onText?: (text: string) => void } = {},
): Promise<AiResult> {
  const { route: r, settings } = plan;
  if (r.target === 'none') throw new Error(r.reason);
  const started = performance.now();

  let sent = request.passages.map((_, i) => i);
  if (r.target === 'ollama' && r.retrieval) {
    sent = await closestPassages(request, settings, opts.signal);
  }
  const document = sent
    .map((i) => (request.numbered ? `[${i + 1}] ${request.passages[i]}` : request.passages[i]))
    .join('\n\n');

  let text: string;
  let model: string;
  if (r.target === 'claude') {
    model = r.model;
    text = await claudeStream({
      apiKey: settings.claudeKey,
      model,
      system: request.system,
      document,
      prompt: request.prompt,
      signal: opts.signal,
      onText: opts.onText,
    });
  } else {
    model = settings.ollamaChatModel;
    text = await chat({
      url: settings.ollamaUrl,
      model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: `${document}\n\n${request.prompt}` },
      ],
      signal: opts.signal,
      onText: opts.onText,
    });
  }

  const ms = Math.round(performance.now() - started);
  void recordStat({ latency: { task: request.task, target: r.target, ms } });
  if (request.cacheKey && text.trim()) {
    void cachePut(`${request.task}:${request.cacheKey}`, {
      text,
      target: r.target,
      model,
      at: Date.now(),
    });
  }
  return { text, route: r, model, sent, cached: false };
}

/**
 * The passages nearest the prompt, kept in document order and cut to what the
 * local model takes. Without an embedding model it falls back to the opening
 * passages — worse, but an answer rather than an error.
 */
async function closestPassages(
  request: AiRequest,
  settings: Settings,
  signal?: AbortSignal,
): Promise<number[]> {
  let ranked: number[];
  try {
    const embedWith = (input: string[]) =>
      embed({ url: settings.ollamaUrl, model: settings.ollamaEmbedModel, input, signal });
    // A follow-up question about the same document reuses its passage vectors.
    const docKey = `${settings.ollamaEmbedModel}:${hashText(request.passages.join('\u0000'))}`;
    if (passageMemo?.key !== docKey) {
      passageMemo = { key: docKey, vectors: await embedWith(request.passages) };
    }
    const [query] = await embedWith([request.prompt]);
    ranked = topK(query, passageMemo.vectors, request.passages.length);
  } catch (err) {
    if (signal?.aborted) throw err;
    ranked = request.passages.map((_, i) => i);
  }
  const picked: number[] = [];
  let budget = LOCAL_CONTEXT_CHARS;
  for (const index of ranked) {
    const size = request.passages[index].length;
    if (size > budget) continue;
    picked.push(index);
    budget -= size;
  }
  return picked.sort((a, b) => a - b);
}

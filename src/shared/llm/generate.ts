import { getSettings } from '../storage';
import type { Settings } from '../types';
import { claudeStream } from './claude';
import { route, type AiSource, type AiTask, type Route } from './route';
import { cacheGet, cachePut } from './store';

/**
 * One AI call, start to finish: cache, route, run on Haiku, cache the answer.
 * Split in two (`plan`, then `run`) so the UI can show "unavailable" before
 * anything is sent.
 */

/** For prompts whose answer is rendered as Markdown: math the renderer (KaTeX) can draw. */
export const MATH_RULE = ' Write any math as LaTeX: $…$ inline, $$…$$ on its own line.';

export interface AiRequest {
  task: AiTask;
  source: AiSource;
  system: string;
  /** The grounding text as passages (alphaXiv pages); `numbered` labels them [1]..[n]. */
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
  model: string;
  cached: boolean;
}

export async function planAi(): Promise<AiPlan> {
  const settings = await getSettings();
  return { settings, route: route({ online: navigator.onLine, hasKey: settings.claudeKey !== '' }) };
}

export async function cachedAi(request: AiRequest): Promise<AiResult | null> {
  if (!request.cacheKey) return null;
  const hit = await cacheGet(`${request.task}:${request.cacheKey}`);
  if (!hit) return null;
  return { text: hit.text, route: { target: 'claude', model: hit.model, reason: 'Saved answer' }, model: hit.model, cached: true };
}

export async function runAi(
  request: AiRequest,
  plan: AiPlan,
  opts: { signal?: AbortSignal; onText?: (text: string) => void } = {},
): Promise<AiResult> {
  const { route: r, settings } = plan;
  if (r.target === 'none') throw new Error(r.reason);
  const document = request.passages
    .map((p, i) => (request.numbered ? `[${i + 1}] ${p}` : p))
    .join('\n\n');
  const text = await claudeStream({
    apiKey: settings.claudeKey,
    model: r.model,
    system: request.system,
    document,
    prompt: request.prompt,
    cache: true,
    signal: opts.signal,
    onText: opts.onText,
  });
  if (request.cacheKey && text.trim()) {
    void cachePut(`${request.task}:${request.cacheKey}`, { text, target: 'claude', model: r.model, at: Date.now() });
  }
  return { text, route: r, model: r.model, cached: false };
}

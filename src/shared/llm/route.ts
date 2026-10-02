import { CLAUDE_MODELS, LOCAL_CONTEXT_CHARS } from '../constants';
import type { CloudMode } from '../types';

/**
 * Where one AI call runs, decided by rules rather than by asking a model.
 *
 * The order of concern is privacy, then offline, then speed. Private content
 * never leaves the machine — not when it is too long, not when Ollama is down.
 * Public content (a feed item, an arXiv/DOI paper, a YouTube video) may go to
 * Claude, but only when the user turned that on and the local model cannot
 * take it. Everything else stays on device.
 *
 * Pure, so the whole decision table is a unit test (route.test.ts).
 */

export type AiTask = 'recap' | 'triage' | 'summarize' | 'ask';

export type AiSource = 'rss' | 'arxiv' | 'doi' | 'youtube' | 'web' | 'localFile' | 'annotation';

export interface RouteEnv {
  ollamaUp: boolean;
  /** A chat model is picked in Settings */
  hasLocalModel: boolean;
  online: boolean;
  cloudMode: CloudMode;
  hasKey: boolean;
}

export type Route =
  | { target: 'ollama'; retrieval: boolean; reason: string }
  | { target: 'claude'; model: string; confirm: boolean; reason: string }
  | { target: 'none'; reason: string };

/**
 * A web page counts as private: a logged-in page (mail, a bank, an intranet)
 * looks exactly like a public one from here, so no URL rule can be trusted to
 * tell them apart. Only sources that are public by construction qualify.
 */
export function isPublic(source: AiSource): boolean {
  return source === 'rss' || source === 'arxiv' || source === 'doi' || source === 'youtube';
}

export function route(
  call: { task: AiTask; source: AiSource; chars: number },
  env: RouteEnv,
): Route {
  const local = env.ollamaUp && env.hasLocalModel;
  const fits = call.chars <= LOCAL_CONTEXT_CHARS;

  // Frequent, small, and run without anyone asking: never worth a network call.
  if (call.task === 'recap' || call.task === 'triage') {
    return local
      ? { target: 'ollama', retrieval: false, reason: 'Short task, always on device' }
      : { target: 'none', reason: localMissing(env) };
  }

  if (local && fits) {
    return { target: 'ollama', retrieval: false, reason: 'Fits the local model' };
  }

  const cloudAllowed =
    isPublic(call.source) && env.cloudMode !== 'off' && env.hasKey && env.online;
  if (cloudAllowed) {
    const why = local ? 'Too long for the local model' : localMissing(env);
    return {
      target: 'claude',
      model: call.task === 'ask' ? CLAUDE_MODELS.deep : CLAUDE_MODELS.quick,
      confirm: env.cloudMode === 'ask',
      reason: `${why} · public source`,
    };
  }

  if (local) {
    return {
      target: 'ollama',
      retrieval: true,
      reason: isPublic(call.source)
        ? 'Too long for the local model · answered from the closest passages'
        : 'Private document stays on device · answered from the closest passages',
    };
  }

  return { target: 'none', reason: localMissing(env) };
}

function localMissing(env: RouteEnv): string {
  if (!env.ollamaUp) return 'Ollama is not running';
  return 'No local model picked in Settings';
}

/**
 * Classify a document URL. arXiv and DOI-resolved papers are public by
 * construction; a file: URL is the user's disk; anything else is a web page,
 * which counts as private (see isPublic).
 */
export function sourceForUrl(url: string): AiSource {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'localFile';
    host = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'web';
  }
  if (host === 'arxiv.org' || host.endsWith('.arxiv.org')) return 'arxiv';
  if (host === 'doi.org' || host === 'dx.doi.org') return 'doi';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  return 'web';
}

import { CLAUDE_MODELS, LOCAL_CONTEXT_CHARS } from '../constants';
import type { CloudMode } from '../types';

/**
 * Where one AI call runs, decided by rules rather than by asking a model.
 *
 * The order of concern is privacy, then offline, then speed. Private content
 * never leaves the machine — not when it is too long, not when Ollama is down.
 * Public content (a feed item, an arXiv/DOI paper, a YouTube video) may go to
 * Claude, but only when the user turned that on. With cloud mode "public" it
 * goes to Haiku first, because that is faster than a local 8B model; with "ask"
 * it goes only when the local model cannot take it. Everything else stays on
 * device — unless cloud mode is "all", where the user chose Haiku for
 * everything, private sources included, and the local model is the fallback.
 *
 * Pure, so the whole decision table is a unit test (route.test.ts).
 */

export type AiTask = 'recap' | 'triage' | 'summarize' | 'ask' | 'terms' | 'provoke';

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
  /** Never chosen by route(): a video summary takes it when the transcript can't be read. */
  | { target: 'gemini'; model: string; reason: string }
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
  if (env.cloudMode === 'all' && env.hasKey && env.online) {
    return { target: 'claude', model: CLAUDE_MODELS.quick, confirm: false, reason: 'Claude Haiku for everything' };
  }

  const local = env.ollamaUp && env.hasLocalModel;
  const fits = call.chars <= LOCAL_CONTEXT_CHARS;

  const cloudAllowed =
    isPublic(call.source) && env.cloudMode !== 'off' && env.hasKey && env.online;

  // Public content with cloud mode "public": the user already said it may go,
  // so take the faster model. Triage runs unprompted over every feed item, so
  // it stays local; "ask" mode would prompt on every page turn for the small
  // tasks, so those stay local below.
  if (cloudAllowed && env.cloudMode === 'public' && call.task !== 'triage') {
    return {
      target: 'claude',
      model: CLAUDE_MODELS.quick,
      confirm: false,
      reason: 'Public source · Haiku is faster than the local model',
    };
  }

  // Frequent, small, and run without anyone asking: never worth a prompt.
  if (call.task === 'recap' || call.task === 'triage' || call.task === 'terms' || call.task === 'provoke') {
    return local
      ? { target: 'ollama', retrieval: false, reason: 'Short task, always on device' }
      : { target: 'none', reason: localMissing(env) };
  }

  if (local && fits) {
    return { target: 'ollama', retrieval: false, reason: 'Fits the local model' };
  }

  if (cloudAllowed) {
    const why = local ? 'Too long for the local model' : localMissing(env);
    return {
      target: 'claude',
      model: CLAUDE_MODELS.quick,
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

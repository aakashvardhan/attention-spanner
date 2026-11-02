import { CLAUDE_MODELS } from '../constants';

/**
 * Where one AI call runs. Papers are public arXiv documents and Haiku is the
 * only writer (alphaXiv grounds, Haiku writes), so the decision is just
 * whether Haiku is reachable. Pure, so it is a unit test (route.test.ts).
 */

export type AiTask = 'question' | 'grade' | 'terms' | 'reframe';

export type AiSource = 'arxiv' | 'annotation';

export interface RouteEnv {
  online: boolean;
  hasKey: boolean;
}

export type Route =
  | { target: 'claude'; model: string; reason: string }
  | { target: 'none'; reason: string };

export function route(env: RouteEnv): Route {
  if (!env.hasKey) return { target: 'none', reason: 'Add a Claude API key in Settings' };
  if (!env.online) return { target: 'none', reason: 'You are offline' };
  return { target: 'claude', model: CLAUDE_MODELS.quick, reason: 'Claude Haiku' };
}

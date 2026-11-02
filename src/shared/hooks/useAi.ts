import { useCallback, useEffect, useRef, useState } from 'react';
import { cachedAi, planAi, runAi, type AiPlan, type AiRequest, type AiResult } from '../llm/generate';
import type { Route } from '../llm/route';

export type AiStatus = 'idle' | 'working' | 'streaming' | 'done' | 'error' | 'unavailable';

export interface AiView {
  status: AiStatus;
  text: string;
  route: Route | null;
  model: string;
  error: string;
}

const IDLE: AiView = { status: 'idle', text: '', route: null, model: '', error: '' };

/**
 * One AI call's lifecycle for a component: cache → plan → stream.
 * A newer `start` supersedes an older one, and unmounting aborts the stream,
 * so a stale answer can never land in the wrong card.
 */
export function useAi() {
  const [view, setView] = useState<AiView>(IDLE);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);

  useEffect(() => () => controller.current?.abort(), []);

  /** Stream one answer into the view, whichever model writes it. */
  const drive = useCallback(
    async (
      id: number,
      route: Route,
      run: (signal: AbortSignal, onText: (text: string) => void) => Promise<AiResult>,
    ) => {
      controller.current?.abort();
      const ctrl = new AbortController();
      controller.current = ctrl;
      setView({ ...IDLE, status: 'working', route });
      try {
        const result = await run(ctrl.signal, (text) => {
          if (generation.current === id) setView((v) => ({ ...v, status: 'streaming', text }));
        });
        if (generation.current !== id) return;
        setView({ ...IDLE, status: 'done', text: result.text, route: result.route, model: result.model });
      } catch (err) {
        if (generation.current !== id) return;
        if (ctrl.signal.aborted) {
          // Stopped by the user: keep what streamed so far rather than wiping it.
          setView((v) => ({ ...v, status: v.text ? 'done' : 'idle' }));
          return;
        }
        setView((v) => ({ ...v, status: 'error', error: err instanceof Error ? err.message : String(err) }));
      }
    },
    [],
  );

  const execute = useCallback(
    (request: AiRequest, plan: AiPlan, id: number) =>
      drive(id, plan.route, (signal, onText) => runAi(request, plan, { signal, onText })),
    [drive],
  );

  /** Show a saved answer if there is one; never generates. */
  const showCached = useCallback(async (request: AiRequest) => {
    const id = ++generation.current;
    const hit = await cachedAi(request);
    if (hit && generation.current === id) {
      setView({ ...IDLE, status: 'done', text: hit.text, route: hit.route, model: hit.model });
    }
    return hit !== null;
  }, []);

  const start = useCallback(
    async (request: AiRequest) => {
      const id = ++generation.current;
      const hit = await cachedAi(request);
      if (generation.current !== id) return;
      if (hit) {
        setView({ ...IDLE, status: 'done', text: hit.text, route: hit.route, model: hit.model });
        return;
      }
      setView({ ...IDLE, status: 'working' });
      const plan = await planAi();
      if (generation.current !== id) return;
      if (plan.route.target === 'none') {
        setView({ ...IDLE, status: 'unavailable', route: plan.route, error: plan.route.reason });
        return;
      }
      await execute(request, plan, id);
    },
    [execute],
  );

  const stop = useCallback(() => controller.current?.abort(), []);

  const dismiss = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    setView(IDLE);
  }, []);

  return { view, start, stop, dismiss, showCached };
}

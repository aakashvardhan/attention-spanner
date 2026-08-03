import type { ActiveIntent, AnyProgress, IntentResumeContext } from './types';
import { belongsInContinue, progressKind } from './progress';

export function intentFromRecommendation(
  text: string,
  noteId: string,
  now = Date.now(),
): ActiveIntent {
  return {
    id: crypto.randomUUID(),
    text: text.trim(),
    source: 'brainDump',
    sourceId: noteId,
    fromTodayBrainDump: true,
    createdAt: now,
    startedAt: null,
    state: 'ready',
    resumeContext: null,
  };
}

export function resumeContextFromProgress(progress: AnyProgress): IntentResumeContext {
  if (progress.kind === 'video') {
    return {
      kind: 'video',
      url: progress.url,
      title: progress.title || progress.url,
      positionSeconds: progress.positionSeconds,
      breadcrumb: '',
    };
  }
  return {
    kind: 'article',
    url: progress.url,
    title: progress.title || progress.url,
    scrollY: progress.scrollY,
    breadcrumb: '',
  };
}

export function mostRecentUnfinished(
  progress: Record<string, AnyProgress>,
  now = Date.now(),
): AnyProgress | null {
  return (
    Object.values(progress)
      .filter((entry) => belongsInContinue(entry, now))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  );
}

export function progressLabel(progress: AnyProgress): string {
  return progressKind(progress) === 'video' ? 'unfinished video' : 'unfinished reading';
}

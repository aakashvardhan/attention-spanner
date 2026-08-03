import type { DayStats, Gamification, Streaks } from '../types';
import { weekDates } from '../week';
import type { Journal } from './journal';
import { formatLooseEnds, type LooseEnd } from './looseEnds';

/**
 * The weekly reckoning.
 *
 * Everything countable is counted here, in pure code, and the model only gets
 * to phrase it. That split is the whole design: a review that says "you had a
 * strong week" without knowing the numbers is horoscope, and a model asked to
 * tally its own inputs will quietly get them wrong. The prompt is explicitly
 * forbidden from producing figures the summary does not contain.
 */

export const MAX_NEXT_PRIORITIES = 3;
export const REVIEW_MAX_CHARS = 700;

export interface WeekSummary {
  weekKey: string;
  /** Days in the week that had a plan at all */
  daysPlanned: number;
  prioritiesPlanned: number;
  prioritiesDone: number;
  /** Days the user closed out with the "close out the day" button */
  daysClosedOut: number;
  readingMinutes: number;
  sprints: number;
  tasksCompleted: number;
  /** Actions the assistant applied on the user's behalf */
  actionsRun: number;
  /** Reflections the user wrote at close-out, oldest first */
  reflections: string[];
  looseEnds: LooseEnd[];
}

export interface WeekReviewData {
  journal: Journal;
  streaks: Streaks;
  gamification: Gamification;
  looseEnds: LooseEnd[];
}

/**
 * Count the week identified by `key` (its Monday). Only days inside the week
 * are read, so running this on a Friday reports a partial week honestly rather
 * than padding it with last week's numbers.
 */
export function buildWeekSummary(data: WeekReviewData, key: string): WeekSummary {
  const dates = weekDates(key);
  const summary: WeekSummary = {
    weekKey: key,
    daysPlanned: 0,
    prioritiesPlanned: 0,
    prioritiesDone: 0,
    daysClosedOut: 0,
    readingMinutes: 0,
    sprints: 0,
    tasksCompleted: 0,
    actionsRun: 0,
    reflections: [],
    looseEnds: data.looseEnds,
  };

  for (const date of dates) {
    const day = data.journal[date];
    if (day?.plan) {
      summary.daysPlanned++;
      summary.prioritiesPlanned += day.plan.priorities.length;
      summary.prioritiesDone += day.plan.priorities.filter((p) => p.done).length;
      if (day.plan.reviewedAt !== null) summary.daysClosedOut++;
      if (day.plan.reflection) summary.reflections.push(day.plan.reflection);
    }
    summary.actionsRun += day?.entries.filter((e) => e.kind === 'action').length ?? 0;

    const stats: DayStats | undefined = data.streaks.daily[date];
    if (stats) {
      summary.readingMinutes += Math.round(stats.minutes);
      summary.sprints += stats.sprints;
      summary.tasksCompleted += stats.tasksCompleted ?? 0;
    }
  }

  return summary;
}

/** The counted facts, as plain lines for the prompt and the fallback text. */
export function formatWeekSummary(summary: WeekSummary): string {
  const lines = [
    `Week of ${summary.weekKey}.`,
    `Days planned: ${summary.daysPlanned}/7; days closed out: ${summary.daysClosedOut}.`,
    `Priorities: ${summary.prioritiesDone} done of ${summary.prioritiesPlanned} planned.`,
    `Reading: ${summary.readingMinutes} minutes across ${summary.sprints} sprints.`,
    `Tasks completed: ${summary.tasksCompleted}. Assistant actions run: ${summary.actionsRun}.`,
  ];
  if (summary.reflections.length > 0) {
    lines.push('What they wrote at close-out:', ...summary.reflections.map((r) => `- ${r}`));
  }
  lines.push('Stalled items:', formatLooseEnds(summary.looseEnds));
  return lines.join('\n');
}

/**
 * The deterministic review — always available, and the fallback when no model
 * is. Blunt by house style; no praise, no pep talk.
 */
export function templateReview(summary: WeekSummary): string {
  const parts: string[] = [];

  if (summary.daysPlanned === 0) {
    parts.push('No day plans this week, so there is nothing to compare against.');
  } else {
    const rate =
      summary.prioritiesPlanned === 0
        ? 0
        : Math.round((summary.prioritiesDone / summary.prioritiesPlanned) * 100);
    parts.push(
      `Planned ${summary.daysPlanned} of 7 days and finished ${summary.prioritiesDone} of ` +
        `${summary.prioritiesPlanned} priorities (${rate}%).`,
    );
  }

  parts.push(
    `${summary.readingMinutes} minutes read, ${summary.tasksCompleted} tasks done, `
  );

  if (summary.looseEnds.length > 0) {
    parts.push(
      `${summary.looseEnds.length} thing${summary.looseEnds.length === 1 ? '' : 's'} stalled, ` +
        `oldest: ${summary.looseEnds[0].label} (${summary.looseEnds[0].staleDays}d).`,
    );
  }

  return parts.join(' ').slice(0, REVIEW_MAX_CHARS);
}

export function buildReviewPrompt(summary: string): string {
  return (
    'You write a weekly review for a person with ADHD using a reading/productivity extension. ' +
    'Use ONLY the counted figures below — never compute, estimate or invent a number that is ' +
    'not there. Write 3-4 blunt sentences: what actually got done, the one pattern worth ' +
    'naming, and what is stalled. No praise, no pep talk, no greetings, no emoji. Then propose ' +
    `at most ${MAX_NEXT_PRIORITIES} priorities for next week, each a concrete action drawn from ` +
    'what is stalled or unfinished.\n\nCounted figures:\n' +
    summary
  );
}

export function buildReviewSchema(): object {
  return {
    type: 'object',
    required: ['summary', 'priorities'],
    additionalProperties: false,
    properties: {
      summary: { type: 'string', description: '3-4 blunt sentences about the week' },
      priorities: {
        type: 'array',
        maxItems: MAX_NEXT_PRIORITIES,
        items: { type: 'string', description: 'A concrete action for next week' },
      },
    },
  };
}

/** Parse a model review; anything malformed falls back to the template text. */
export function parseReviewReply(
  raw: string,
  fallback: string,
): { summary: string; priorities: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { summary: fallback, priorities: [] };
  }
  const obj = parsed as { summary?: unknown; priorities?: unknown };
  const summary = String(obj?.summary ?? '').trim().slice(0, REVIEW_MAX_CHARS);
  const priorities = Array.isArray(obj?.priorities)
    ? obj.priorities
        .map((p) => String(p ?? '').trim())
        .filter(Boolean)
        .slice(0, MAX_NEXT_PRIORITIES)
    : [];
  return { summary: summary || fallback, priorities };
}

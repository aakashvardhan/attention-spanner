import { localDate } from '../../format';
import { getLocal, getSettings, setLocal } from '../../storage';
import type { WeekReview } from '../../types';
import { weekKey } from '../../week';
import { newTurn } from '../assistantTypes';
import { cloudProviderFor, hasCloudKey } from '../cloud';
import { describePlan, generateDayPlan } from '../dayPlan';
import { findLooseEnds, formatLooseEnds } from '../looseEnds';
import { nanoProvider } from '../nanoProvider';
import {
  buildReviewPrompt,
  buildReviewSchema,
  buildWeekSummary,
  formatWeekSummary,
  parseReviewReply,
  templateReview,
} from '../weekReview';
import { NO_PARAMS, type Connector } from './base';

/**
 * The daily and weekly loop: plan the day, read it back, reckon on the week.
 * The plans themselves live in the journal (LocalSchema.assistantJournal), so
 * these tools are thin — what a plan contains is decided in ai/dayPlan.ts and
 * what a week counts is decided in ai/weekReview.ts.
 *
 * None of these are `confirm`ed: they write only the assistant's own records
 * (a plan, a review) and never touch tasks, papers or the calendar. Re-running
 * one is how you fix a result you don't like.
 */

async function loadLooseEnds() {
  const { papers, readingProgress, tasks } = await getLocal(
    'papers',
    'readingProgress',
    'tasks',
  );
  return findLooseEnds({ papers, readingProgress, tasks });
}

/** Build this week's review, store it, return the text. */
export async function runWeeklyReview(now = new Date()): Promise<string> {
  const key = weekKey(now);
  const [{ assistantJournal, streaks, gamification }, settings, looseEnds] = await Promise.all([
    getLocal('assistantJournal', 'streaks', 'gamification'),
    getSettings(),
    loadLooseEnds(),
  ]);

  const summary = buildWeekSummary(
    {
      journal: assistantJournal,
      streaks,
      gamification,
      looseEnds,
    },
    key,
  );

  const fallback = templateReview(summary);
  let review = { summary: fallback, priorities: [] as string[] };
  const provider = hasCloudKey(settings) ? cloudProviderFor(settings) : nanoProvider;
  try {
    if (await provider.available()) {
      const reply = await provider.generate({
        system: buildReviewPrompt(formatWeekSummary(summary)),
        turns: [newTurn('user', 'Write my weekly review.')],
        responseSchema: buildReviewSchema(),
      });
      review = parseReviewReply(reply.text, fallback);
    }
  } catch {
    // template review already in place
  }

  const record: WeekReview = {
    weekKey: key,
    summary: review.summary,
    priorities: review.priorities,
    createdAt: now.getTime(),
  };
  const { weekReviews } = await getLocal('weekReviews');
  await setLocal({ weekReviews: { ...weekReviews, [key]: record } });

  const next =
    review.priorities.length > 0
      ? `\n\nFor next week: ${review.priorities.map((p, i) => `${i + 1}. ${p}`).join(' ')}`
      : '';
  return review.summary + next;
}

export const planningConnector: Connector = {
  id: 'planning',
  label: 'Planning',
  isAvailable: () => true,
  tools: [
    {
      name: 'plan_day',
      // No confirm chip, but it overwrites today's plan and runs a model call.
      loop: 'stage',
      description:
        "Build (or rebuild) today's plan: pick today's priorities from the user's open tasks and lay out their day around their calendar. Use for \"plan my day\", \"what should I do today\", \"re-plan my day\", \"what are my priorities\".",
      params: NO_PARAMS,
      palette: { label: 'Plan my day', keywords: ['plan', 'day', 'today', 'priorities'] },
      summary: () => 'Plan the day',
      run: async () => {
        const plan = await generateDayPlan({ force: true });
        if (!plan) return 'The assistant is turned off in Settings.';
        return describePlan(plan);
      },
    },
    {
      name: 'show_plan',
      loop: 'auto',
      description:
        "Read back today's existing plan and which priorities are still open. Use for \"what's on my plan\", \"what's left today\", \"how am I doing today\". Does not build a new plan.",
      params: NO_PARAMS,
      summary: () => "Show today's plan",
      run: async () => {
        const { assistantJournal } = await getLocal('assistantJournal');
        const plan = assistantJournal[localDate(new Date())]?.plan;
        if (!plan) return "No plan for today yet — say “plan my day” and I'll build one.";
        const left = plan.priorities.filter((p) => !p.done);
        if (left.length === 0) {
          return plan.priorities.length === 0
            ? 'Nothing on the list today — add a task and re-plan.'
            : 'Everything on today’s plan is done.';
        }
        return `${left.length} left: ${left.map((p) => `${p.text} (${p.estimateMin}m)`).join('; ')}.`;
      },
    },
    {
      name: 'weekly_review',
      // No confirm chip, but it runs a model call and writes weekReviews.
      loop: 'stage',
      description:
        'Review the week: how many planned priorities actually got done, what the reading and task numbers were, and what is stalled — then propose next week\'s priorities. Use for "weekly review", "how was my week", "review my week".',
      params: NO_PARAMS,
      palette: { label: 'Weekly review', keywords: ['week', 'review', 'recap', 'retro'] },
      summary: () => 'Review the week',
      run: () => runWeeklyReview(),
    },
    {
      name: 'loose_ends',
      loop: 'auto',
      description:
        'List things the user started and dropped — papers abandoned partway, articles left unfinished for weeks, tasks that have sat on the list for a month. Use for "what have I dropped", "loose ends", "what am I forgetting", "what did I abandon".',
      params: NO_PARAMS,
      palette: { label: 'What have I dropped?', keywords: ['loose', 'stalled', 'dropped', 'abandoned'] },
      summary: () => 'List loose ends',
      run: async () => formatLooseEnds(await loadLooseEnds()),
    },
  ],
};

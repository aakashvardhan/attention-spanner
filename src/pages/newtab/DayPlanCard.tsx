import { useState } from 'react';
import { runWeeklyReview } from '../../shared/ai/connectors/planning';
import { generateDayPlan, REFLECTION_MAX_CHARS } from '../../shared/ai/dayPlan';
import { Button, EmptyState, Panel } from '../../shared/components/ui';
import { localDate } from '../../shared/format';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import type { DayPlan, PlanPriority } from '../../shared/types';
import { weekKey } from '../../shared/week';

/**
 * Today's plan: three priorities to tick off and the shape of the day around
 * them. The briefing card says what is urgent; this one is what you committed
 * to, and it is still here tomorrow for the weekly review to count.
 *
 * Every write goes through the worker (JOURNAL_PATCH_PLAN) so this card and an
 * alarm-driven automation can't clobber each other's copy of the journal.
 */
export function DayPlanCard() {
  const [journal] = useStorageValue('assistantJournal');
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [reflection, setReflection] = useState('');

  const today = localDate(new Date());
  const plan: DayPlan | null = journal?.[today]?.plan ?? null;

  const build = async () => {
    setBusy(true);
    await generateDayPlan({ force: true }).catch(() => undefined);
    setBusy(false);
  };

  const patch = (patchBody: Partial<DayPlan>) =>
    void sendMessage({ type: 'JOURNAL_PATCH_PLAN', date: today, patch: patchBody });

  const togglePriority = (index: number) => {
    if (!plan) return;
    const priorities = plan.priorities.map((p, i) => (i === index ? { ...p, done: !p.done } : p));
    patch({ priorities });
    // A priority that came from a real task toggles that task too, so the plan
    // and the task list can't drift apart during the day. Toggle rather than
    // complete, so unticking here undoes it there as well.
    const target: PlanPriority = plan.priorities[index];
    if (target.taskId) {
      void sendMessage({ type: 'TOGGLE_TASK', id: target.taskId }).catch(() => undefined);
    }
  };

  const closeOut = () => {
    patch({ reviewedAt: Date.now(), reflection: reflection.trim().slice(0, REFLECTION_MAX_CHARS) });
    setClosing(false);
    setReflection('');
  };

  if (!plan) {
    return (
      <Panel title="Day plan">
        <EmptyState>No plan yet today.</EmptyState>
        <Button block disabled={busy} onClick={() => void build()}>
          {busy ? 'Planning…' : 'Plan my day'}
        </Button>
      </Panel>
    );
  }

  const done = plan.priorities.filter((p) => p.done).length;

  return (
    <Panel
      title="Day plan"
      action={
        <Button variant="ghost" disabled={busy} onClick={() => void build()}>
          {busy ? '…' : 'Re-plan'}
        </Button>
      }
    >
      {plan.priorities.length === 0 ? (
        <EmptyState>Nothing on the list — add a task, then re-plan.</EmptyState>
      ) : (
        <ul className="dp-priorities">
          {plan.priorities.map((p, i) => (
            <li key={`${p.text}-${i}`} className={p.done ? 'dp-priority done' : 'dp-priority'}>
              <label>
                <input type="checkbox" checked={p.done} onChange={() => togglePriority(i)} />
                <span className="dp-text">{p.text}</span>
                <span className="dp-estimate">{p.estimateMin}m</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {/* Not .panel-scroll: that carries a 12px/20px fade mask sized for tall
          lists, which swallows a block row whole when there are only one or two */}
      {plan.blocks.length > 0 && (
        <div className="dp-blocks">
          {plan.blocks.map((b, i) => (
            <div key={`${b.start}-${i}`} className={`dp-block ${b.source}`}>
              <span className="dp-time">
                {b.start}–{b.end}
              </span>
              <span className="dp-label">{b.label}</span>
            </div>
          ))}
        </div>
      )}

      {plan.reviewedAt !== null ? (
        <p className="dp-closed">
          Day closed — {done}/{plan.priorities.length} done
          {plan.reflection && <> · “{plan.reflection}”</>}
        </p>
      ) : closing ? (
        <div className="dp-close-form">
          <input
            type="text"
            value={reflection}
            maxLength={REFLECTION_MAX_CHARS}
            placeholder="How did it actually go? (optional)"
            autoFocus
            onChange={(e) => setReflection(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') closeOut();
              if (e.key === 'Escape') setClosing(false);
            }}
          />
          <Button onClick={closeOut}>Save</Button>
        </div>
      ) : (
        <Button block variant="tinted" onClick={() => setClosing(true)}>
          Close out the day ({done}/{plan.priorities.length})
        </Button>
      )}

      <WeekReviewPanel />
    </Panel>
  );
}

/**
 * The week's reckoning, offered from Friday — early enough to act on, late
 * enough that the numbers mean something. Hidden the rest of the week rather
 * than sitting there greyed out: a control you can't use is noise.
 */
function WeekReviewPanel() {
  const [reviews] = useStorageValue('weekReviews');
  const [busy, setBusy] = useState(false);
  const now = new Date();
  const key = weekKey(now);
  const existing = reviews?.[key];
  const isFridayOrLater = now.getDay() === 0 || now.getDay() >= 5;

  if (!isFridayOrLater && !existing) return null;

  const run = async () => {
    setBusy(true);
    await runWeeklyReview().catch(() => undefined);
    setBusy(false);
  };

  return (
    <div className="dp-review">
      {existing ? (
        <>
          <p className="dp-review-text">{existing.summary}</p>
          {existing.priorities.length > 0 && (
            <ol className="dp-review-next">
              {existing.priorities.map((p, i) => (
                <li key={`${p}-${i}`}>{p}</li>
              ))}
            </ol>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => void run()}>
            {busy ? 'Reviewing…' : 'Redo review'}
          </Button>
        </>
      ) : (
        <Button block variant="ghost" disabled={busy} onClick={() => void run()}>
          {busy ? 'Reviewing…' : 'Weekly review'}
        </Button>
      )}
    </div>
  );
}

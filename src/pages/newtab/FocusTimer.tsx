import { useEffect, useState } from 'react';
import { FocusDial } from '../../shared/components/FocusDial';
import { HoldToQuit } from '../../shared/components/HoldToQuit';
import { formatTime, localDate } from '../../shared/format';
import type { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';

type Focus = ReturnType<typeof useFocusSession>;

/**
 * The Pomodoro, as a shift. Clock in once; focus rounds and breaks follow each
 * other on their own (background/focus.ts) until you clock out. Idle, the whole
 * dial is one big button. Running, it says what phase this is, how long is
 * left, and when the next one starts, because time you cannot see is time you
 * lose. Clocking out of a focus round takes a hold; out of a break, a click.
 * A break opens with a minute of paced breathing, then lets you be.
 */
export function FocusTimer({ focus }: { focus: Focus }) {
  const [settings] = useSettings();
  const [activity] = useStorageValue('activity');
  const today = activity[localDate()];
  const roundsToday = today?.focus ?? 0;
  const clockedToday = (today?.clocked ?? 0) * 60_000 + focus.clockedMs;

  // "Breathe again" restarts the guide for this break only. Kept outside the
  // component too: switching views (V, Reduce Motion, a narrow window) remounts it.
  const [again, setAgainState] = useState(breatheAgain);
  const setAgain = (next: typeof breatheAgain) => setAgainState((breatheAgain = next));
  const [intention, setIntention] = useState('');
  const clockIn = () => void focus.start(settings.focusMinutes, intention);

  // The tab strip shows the time too, by the dial's own rule (minutes in focus).
  const shown = `${focus.display.value}${focus.display.unit ? ' min' : ''}`;
  useEffect(() => {
    const title = document.title;
    if (focus.phase) document.title = `${shown} · ${focus.phase === 'break' ? 'Break' : 'Focus'}`;
    return () => void (document.title = title);
  }, [focus.phase, shown]);

  if (!focus.session) {
    return (
      <section className="pomo" aria-label="Pomodoro">
        <button
          type="button"
          className="pomo-clockin"
          aria-keyshortcuts="c"
          onClick={clockIn}
        >
          <PlayMark />
          <span className="pomo-clockin-text">
            <strong>Clock in</strong>
            <span>
              {settings.focusMinutes} min focus · {settings.breakMinutes} min break · repeats until you clock out
            </span>
          </span>
          <kbd className="pomo-key" aria-hidden="true">C</kbd>
        </button>
        <input
          type="text"
          className="pomo-intention-input"
          value={intention}
          maxLength={120}
          onChange={(event) => setIntention(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') clockIn();
          }}
          placeholder="What's this shift for? (optional)"
          aria-label="What this focus shift is for"
        />
        {clockedToday > 0 && (
          <p className="pomo-today">
            Today: {plural(roundsToday, 'round')} · {duration(clockedToday)} clocked
          </p>
        )}
      </section>
    );
  }

  const onBreak = focus.phase === 'break';
  const nextAt = formatTime(new Date(focus.session.phaseEndsAt));
  const breathFrom = again?.phase === focus.session.phaseStartedAt ? again.at : focus.session.phaseStartedAt;
  const breathing = onBreak && focus.now - breathFrom < BREATH_GUIDE_MS;
  return (
    <section className="pomo" aria-label="Pomodoro" data-phase={focus.phase}>
      <FocusDial focus={focus} breathing={breathing ? { startedAt: breathFrom } : null} />
      <div className="pomo-body">
        <p className="pomo-kicker">
          {onBreak ? 'Break' : 'Focus'} · round {focus.round} · clocked in {duration(focus.clockedMs)}
        </p>
        {focus.session.intention && <p className="pomo-intention">{focus.session.intention}</p>}
        <p className="pomo-next">
          {onBreak
            ? `Stand up, drink water, look far away. Round ${focus.round + 1} starts at ${nextAt}.`
            : `Sites are blocked. A ${settings.breakMinutes}-minute break at ${nextAt}.`}
        </p>
        <div className="pomo-actions">
          {onBreak ? (
            <>
              <button type="button" className="fc-primary-btn" onClick={() => void focus.skipBreak()}>
                Start round {focus.round + 1} now
              </button>
              {!breathing && (
                <button
                  type="button"
                  className="edition-link"
                  onClick={() => setAgain({ phase: focus.session!.phaseStartedAt, at: Date.now() })}
                >
                  Breathe again
                </button>
              )}
              <button type="button" className="edition-link" onClick={() => void focus.stop(false)}>
                Clock out
              </button>
            </>
          ) : (
            <HoldToQuit label="Hold to clock out" onConfirm={() => void focus.stop(true)} />
          )}
        </div>
      </div>
    </section>
  );
}

let breatheAgain: { phase: number; at: number } | null = null;

/** About six guided breaths, then the break is yours. */
const BREATH_GUIDE_MS = 60_000;

/** The idle dial: an empty ring around a play mark. Still, on purpose. */
function PlayMark() {
  return (
    <svg className="pomo-dial" viewBox="0 0 120 120" aria-hidden="true">
      <circle className="pomo-track" cx="60" cy="60" r="52" />
      <path className="pomo-play" d="M50 40 L80 60 L50 80 Z" />
    </svg>
  );
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

import { useEffect, useState } from 'react';
import { HoldToQuit } from '../../shared/components/HoldToQuit';
import { formatTime, localDate } from '../../shared/format';
import type { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';

type Focus = ReturnType<typeof useFocusSession>;

/**
 * The Pomodoro, as a shift: a large clock and one status line under it. Clock
 * in once; focus rounds and breaks follow each other on their own
 * (background/focus.ts) until you clock out. Clocking out of a focus round
 * takes a hold; out of a break, a click. The clock is the page's only serif.
 */
export function FocusTimer({ focus }: { focus: Focus }) {
  const [settings] = useSettings();
  const [activity] = useStorageValue('activity');
  const today = activity[localDate()];
  const roundsToday = today?.focus ?? 0;
  const clockedToday = (today?.clocked ?? 0) * 60_000 + focus.clockedMs;

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
        <p className="pomo-clock">{settings.focusMinutes}:00</p>
        <button type="button" className="pomo-start" aria-keyshortcuts="c" onClick={clockIn}>
          Start focus <kbd aria-hidden="true">C</kbd>
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
        <p className="pomo-note">
          {clockedToday > 0
            ? `Today: ${plural(roundsToday, 'round')} · ${duration(clockedToday)} clocked`
            : `${settings.focusMinutes} min focus, ${settings.breakMinutes} min break, until you clock out`}
        </p>
      </section>
    );
  }

  const onBreak = focus.phase === 'break';
  const nextAt = formatTime(new Date(focus.session.phaseEndsAt));
  return (
    <section className="pomo" aria-label="Pomodoro" data-phase={focus.phase}>
      <p className="pomo-clock" role="timer" aria-label={`${onBreak ? 'Break' : 'Focus'}, ${shown} left`}>
        {focus.countdown}
      </p>
      <p className="pomo-status">{onBreak ? 'break' : 'focus · sites blocked'}</p>
      <p className="pomo-note">
        {onBreak
          ? `Round ${focus.round + 1} at ${nextAt} · clocked in ${duration(focus.clockedMs)}`
          : `Round ${focus.round} · a ${settings.breakMinutes}-minute break at ${nextAt}`}
      </p>
      <div className="pomo-actions">
        {onBreak ? (
          <>
            <button type="button" className="fc-primary-btn" onClick={() => void focus.skipBreak()}>
              Start round {focus.round + 1} now
            </button>
            <button type="button" className="edition-link" onClick={() => void focus.stop(false)}>
              Clock out
            </button>
          </>
        ) : (
          <HoldToQuit label="Hold to clock out" onConfirm={() => void focus.stop(true)} />
        )}
      </div>
    </section>
  );
}

function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

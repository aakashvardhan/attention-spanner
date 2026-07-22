import { useState } from 'react';
import { localDate } from '../../../shared/format';
import { useFocusSession } from '../../../shared/hooks/useFocusSession';
import { BookmarkPicker } from './BookmarkPicker';
import { useSprint } from '../../../shared/hooks/useSprint';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';
import { DEFAULT_SETTINGS } from '../../../shared/storage';

export function FocusBar() {
  const sprint = useSprint();
  const focus = useFocusSession();
  const [streaks] = useStorageValue('streaks');
  const [gym] = useStorageValue('gym');
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  const freezes = streaks.freezeTokens ?? 0;
  const checkedInToday = localDate() in gym.checkins;
  const [picking, setPicking] = useState(false);

  return (
    <>
    <div className="focus-bar">
      <span className="focus-left">
        <span className="focus-streak" title={`Longest: ${streaks.longestStreak} days`}>
          {streaks.currentStreak} day{streaks.currentStreak === 1 ? '' : 's'}
        </span>
        {freezes > 0 && (
          <span
            className="level-chip"
            title={`${freezes} streak freeze${freezes === 1 ? '' : 's'} banked — a missed day is covered automatically`}
          >
            {freezes} freeze{freezes === 1 ? '' : 's'}
          </span>
        )}
      </span>
      <span className="focus-right">
        <button
          className={picking ? 'gym-chip done' : 'gym-chip'}
          title="Bookmark this tab"
          onClick={() => setPicking((p) => !p)}
        >
          Bookmark
        </button>
        {focus.active ? (
          <span
            className="gym-chip done"
            title={
              focus.phase === 'focus'
                ? 'Focus mode active — end it from the dashboard'
                : 'Pomodoro break'
            }
          >
            {focus.phase === 'focus' ? 'Focus' : 'Break'} {focus.countdown}
          </span>
        ) : (
          <button
            className="gym-chip"
            title={`Start a ${settings.focusMinutes}-min focus block (blocks distracting sites)`}
            onClick={() =>
              void focus.start({
                mode: 'oneshot',
                focusMinutes: settings.focusMinutes,
                breakMinutes: 0,
              })
            }
          >
            Focus
          </button>
        )}
        {checkedInToday ? (
          <span className="gym-chip done" title="Gym logged today — undo on the dashboard">
            Gym done
          </span>
        ) : (
          <button
            className="gym-chip"
            title="I went to the gym today"
            onClick={() => void sendMessage({ type: 'GYM_CHECKIN' })}
          >
            Gym
          </button>
        )}
        {sprint.active ? (
          <button className="sprint-btn active" onClick={() => void sprint.cancel()}>
            Stop {sprint.countdown}
          </button>
        ) : (
          <button className="sprint-btn" onClick={() => void sprint.start()}>
            Sprint
          </button>
        )}
      </span>
    </div>
    {picking && <BookmarkPicker onDone={() => setPicking(false)} />}
    </>
  );
}

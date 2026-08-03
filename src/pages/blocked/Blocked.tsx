import { useMemo } from 'react';
import { HoldToQuit } from '../../shared/components/HoldToQuit';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useTasks } from '../../shared/hooks/useTasks';

/**
 * Shown when a blocked site is hit during focus. Zero SW dependency —
 * everything renders from storage, and when the session ends or flips to a
 * break the page live-updates to a "continue" link (blocked tabs
 * self-release; no tab bookkeeping in the worker).
 */
export function Blocked() {
  const focus = useFocusSession();
  const { openTasks } = useTasks();

  const blockedUrl = useMemo(() => {
    const hash = location.hash.slice(1);
    if (!hash) return null;
    try {
      const url = new URL(hash);
      // This page is web-accessible, so any site can navigate the user here
      // with a fragment of its choosing. `new URL` accepts javascript: and
      // data: as readily as https, and the href below is rendered as a link
      // in an extension-origin page — only http(s) may become one.
      return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch {
      return null;
    }
  }, []);
  const host = blockedUrl?.hostname.replace(/^www\./, '');

  const blocking = focus.active && focus.phase === 'focus';

  if (!blocking) {
    return (
      <div className="blocked">
        
        <h1>{focus.active ? 'Break time' : 'Focus session over'}</h1>
        {blockedUrl ? (
          <a className="blocked-continue" href={blockedUrl.href}>
            Continue to {host} →
          </a>
        ) : (
          <p className="blocked-sub">You're free to browse.</p>
        )}
      </div>
    );
  }

  return (
    <div className="blocked">
      
      <h1>{host ? `${host} is blocked` : 'This site is blocked'}</h1>
      <p className="blocked-sub">
        Focus mode{focus.session?.mode === 'pomodoro' ? ` · block ${focus.completedBlocks + 1}` : ''}
        {' — back off in'}
      </p>
      <p className="blocked-countdown">{focus.countdown}</p>

      {focus.session?.intent && (
        <div className="blocked-tasks blocked-intent">
          <p className="blocked-tasks-label">You said the first step is:</p>
          <p className="blocked-intent-text">→ {focus.session.intent}</p>
        </div>
      )}

      {openTasks.length > 0 && (
        <div className="blocked-tasks">
          <p className="blocked-tasks-label">Here's what you said mattered:</p>
          {openTasks.slice(0, 3).map((task) => (
            <p key={task.id} className="blocked-task">
              • {task.text}
            </p>
          ))}
        </div>
      )}

      <div className="blocked-quit">
        <HoldToQuit label="Hold 5s to end focus early" onConfirm={() => void focus.stop(true)} />
      </div>
    </div>
  );
}

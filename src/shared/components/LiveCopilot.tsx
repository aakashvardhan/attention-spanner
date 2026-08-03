import { useEffect, useRef, useState } from 'react';
import { useSessionValue } from '../hooks/useSessionValue';
import { useStorageValue } from '../hooks/useStorageValue';
import { sendMessage } from '../messages';
import { formatTimestamp, type TranscriptSegment } from '../recordings';
import { isLiveActive, LISTEN_PRESETS, type LiveMode } from '../live';
import { Button, EmptyState, Panel } from './ui';
import { Markdown } from './Markdown';
import './liveCopilot.css';

/**
 * The live meeting surface: transcript on one side, suggested answers on the
 * other. Rendered identically by the side panel and the in-page overlay — the
 * component reads session state and sends messages, and holds no logic of its
 * own, which is what lets two hosts share it without either becoming primary.
 */

const MODES: { id: LiveMode; label: string; hint: string }[] = [
  { id: 'question', label: 'On questions', hint: 'Answer when someone asks something' },
  { id: 'pause', label: 'Every pause', hint: 'Answer after each pause — many more requests' },
  { id: 'manual', label: 'Manual', hint: 'Only when you press Suggest' },
];

export function LiveCopilot() {
  const [live] = useSessionValue('liveSession');
  const [recordings] = useStorageValue('recordings');
  const [busy, setBusy] = useState(false);

  const recording = recordings.find((r) => r.id === live.recordingId);
  const active = isLiveActive(live);

  const suggest = async () => {
    setBusy(true);
    try {
      await sendMessage({ type: 'LIVE_SUGGEST' });
    } finally {
      setBusy(false);
    }
  };

  // The result arrives as a live answer, so there is nothing to do with the
  // reply here — the session update renders it.
  const catchUp = async () => {
    setBusy(true);
    try {
      await sendMessage({ type: 'LIVE_CATCH_UP', minutes: 5 });
    } finally {
      setBusy(false);
    }
  };

  if (!active) {
    return (
      <Panel title="Live">
        <EmptyState>
          Start a recording to have Jarvis follow along. Turn on live transcription in
          Settings → Assistant first.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <div className="live">
      <Panel
        title={recording?.title || 'Recording'}
        action={
          <div className="live-actions">
            <Button variant="ghost" onClick={() => void catchUp()} disabled={busy || live.busy}>
              Catch me up
            </Button>
            <Button variant="tinted" onClick={() => void suggest()} disabled={busy || live.busy}>
              {live.busy || busy ? 'Thinking…' : 'Suggest'}
            </Button>
          </div>
        }
      >
        <div className="live-modes" role="group" aria-label="When to answer">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.hint}
              aria-pressed={live.mode === m.id}
              className={live.mode === m.id ? 'live-chip live-chip--on' : 'live-chip'}
              onClick={() => void sendMessage({ type: 'LIVE_SET_MODE', mode: m.id })}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="live-modes" role="group" aria-label="What kind of room">
          {LISTEN_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.body}
              aria-pressed={live.skillId === p.id}
              className={live.skillId === p.id ? 'live-chip live-chip--on' : 'live-chip'}
              // Tapping the pinned one unpins it — no separate "off" control.
              onClick={() =>
                void sendMessage({
                  type: 'LIVE_PIN_SKILL',
                  skillId: live.skillId === p.id ? '' : p.id,
                })
              }
            >
              {p.name}
            </button>
          ))}
        </div>
        {live.error && <p className="live-error">{live.error}</p>}
      </Panel>

      <Transcript segments={recording?.segments ?? []} />

      <section className="live-answers">
        <h2>Suggested</h2>
        {live.answers.length === 0 ? (
          <EmptyState>Nothing suggested yet.</EmptyState>
        ) : (
          // Newest first: mid-meeting you read the top of the list, not the bottom.
          [...live.answers].reverse().map((a) => (
            <article key={a.id} className="live-answer">
              <header>
                <span className="live-at">{formatTimestamp(a.atSec)}</span>
                {a.question && <span className="live-q">{a.question}</span>}
              </header>
              <Markdown text={a.text} />
              {a.followUps && a.followUps.length > 0 && (
                <div className="live-followups">
                  {a.followUps.map((f) => (
                    <button
                      key={f}
                      type="button"
                      className="live-chip"
                      onClick={() => void sendMessage({ type: 'LIVE_ASK', question: f })}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </article>
          ))
        )}
      </section>
    </div>
  );
}

/**
 * The transcript rail. Follows the tail while you're at the bottom and stops
 * the moment you scroll back — reading something from two minutes ago and being
 * yanked away from it is worse than missing the newest line.
 */
function Transcript({ segments }: { segments: TranscriptSegment[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    if (following && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [segments.length, following]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <section className="live-transcript">
      <h2>
        Transcript
        {!following && (
          <button type="button" className="live-jump" onClick={() => setFollowing(true)}>
            Jump to live
          </button>
        )}
      </h2>
      <div className="live-lines" ref={ref} onScroll={onScroll}>
        {segments.length === 0 ? (
          <EmptyState>Listening…</EmptyState>
        ) : (
          segments.map((s) => (
            <p key={s.startSec}>
              <span className="live-at">{formatTimestamp(s.startSec)}</span>
              {s.text}
            </p>
          ))
        )}
      </div>
    </section>
  );
}

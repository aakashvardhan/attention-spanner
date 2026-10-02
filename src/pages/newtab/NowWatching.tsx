import { useEffect, useRef, useState } from 'react';
import type { useNowWatching } from '../../shared/hooks/useNowWatching';
import { sendMessage } from '../../shared/messages';
import { livePositionSeconds } from '../../shared/youtube';
import type { TranscriptSegment } from '../../shared/youtubeCaptions';
import { segmentAt } from '../../shared/youtubeCaptions';
import { CardTitle } from './Icon';

/** The live half of useNowWatching's return, which is the only half this renders. */
type Watching = Extract<ReturnType<typeof useNowWatching>, { active: true }>;

/**
 * Follow a long video: where you are, which chapter, and the transcript block
 * being spoken now.
 *
 * The transcript is fetched on demand and cached for the session. It is read
 * from what the player already loaded (the timedtext tee) rather than driving
 * the player, because the user is watching this video — asking about it must
 * never start playback or flip captions on.
 *
 * This was the side panel's Follow pane, beside the video. On the new tab it is
 * a tab away instead, so it takes the readout with it — the card has to say
 * which video it means, where the position came from, and stay legible with the
 * player nowhere in sight.
 *
 * `watching` arrives as a prop rather than from the hook: the Dashboard already
 * subscribes, and a second call here would run a second 500ms interval against
 * the same state.
 */
export function NowWatching({ watching }: { watching: Watching }) {
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'none'>('idle');
  const [error, setError] = useState('');
  const listRef = useRef<HTMLOListElement>(null);

  const videoId = watching.video.videoId;

  useEffect(() => {
    setSegments(null);
    setStatus('idle');
    setError('');
  }, [videoId]);

  const load = async () => {
    setStatus('loading');
    // The fetch can outlive the service worker (tab reload, repeated injections),
    // and a rejected sendMessage would otherwise leave the button spinning forever.
    try {
      const res = await sendMessage({ type: 'VIDEO_TRANSCRIPT', videoId });
      if (res.ok && res.segments?.length) {
        setSegments(res.segments);
        setStatus('idle');
        return;
      }
      setError(res.error ?? 'No transcript available for this video.');
    } catch {
      setError('Could not reach the transcript. Try again.');
    }
    setStatus('none');
  };

  const current = segments
    ? segmentAt(segments, livePositionSeconds(watching.video, watching.now))
    : -1;

  useEffect(() => {
    if (current < 0) return;
    const el = listRef.current?.children[current] as HTMLElement | undefined;
    // Jumping the list under someone who is following along is exactly the kind
    // of motion the reduced-motion setting exists to stop.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [current]);

  return (
    <section className="relay-watching-card" aria-labelledby="watching-title">
      <div className="nw-head">
        <CardTitle id="watching-title" icon="play">Now watching</CardTitle>
        <h3>{watching.video.title}</h3>
        <p>
          {watching.video.source} · {watching.position} / {watching.duration}
          {watching.chapter && ` · ${watching.chapter}`}
        </p>
        <div
          className="nw-meter"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(watching.percent)}
          aria-label="Playback position"
        >
          <span style={{ width: `${watching.percent}%` }} />
        </div>
      </div>

      <div className="nw-actions">
        {/* The player is in another tab now, so the card needs a way back to it. */}
        <button
          type="button"
          className="nw-button"
          onClick={() => void sendMessage({ type: 'FOCUS_VIDEO_TAB', videoId })}
        >
          Open the video
        </button>
        {!segments && status !== 'none' && (
          <button
            type="button"
            className="nw-button"
            disabled={status === 'loading'}
            onClick={() => void load()}
          >
            {status === 'loading' ? 'Loading transcript…' : 'Follow the transcript'}
          </button>
        )}
      </div>

      {status === 'none' && <p className="relay-empty">{error}</p>}

      {segments && (
        <ol className="nw-transcript" ref={listRef}>
          {segments.map((segment, i) => (
            <li key={segment.startSec} aria-current={i === current ? 'true' : undefined}>
              <span className="nw-stamp">{stamp(segment.startSec)}</span>
              <span>{segment.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

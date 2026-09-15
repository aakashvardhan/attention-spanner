import { useEffect, useRef, useState } from 'react';
import { useNowWatching } from '../../../shared/hooks/useNowWatching';
import { sendMessage } from '../../../shared/messages';
import type { TranscriptSegment } from '../../../shared/youtubeCaptions';
import { livePositionSeconds } from '../../../shared/youtube';
import { segmentAt } from '../../../shared/youtubeCaptions';

/**
 * Follow a long video: where you are, which chapter, and the transcript block
 * being spoken now.
 *
 * The transcript is fetched on demand and cached for the session. It is read
 * from what the player already loaded (the timedtext tee) rather than driving
 * the player, because the user is watching this video — asking about it must
 * never start playback or flip captions on.
 */
export function NowWatching() {
  const watching = useNowWatching();
  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'none'>('idle');
  const [error, setError] = useState('');
  const listRef = useRef<HTMLOListElement>(null);

  const videoId = watching.active ? watching.video.videoId : null;

  useEffect(() => {
    setSegments(null);
    setStatus('idle');
    setError('');
  }, [videoId]);

  const load = async () => {
    if (!videoId) return;
    setStatus('loading');
    const res = await sendMessage({ type: 'VIDEO_TRANSCRIPT', videoId });
    if (res.ok && res.segments?.length) {
      setSegments(res.segments);
      setStatus('idle');
    } else {
      setStatus('none');
      setError(res.error ?? 'No transcript available for this video.');
    }
  };

  const current =
    segments && watching.active
      ? segmentAt(segments, livePositionSeconds(watching.video))
      : -1;

  useEffect(() => {
    if (current < 0) return;
    const el = listRef.current?.children[current] as HTMLElement | undefined;
    // Jumping the list under someone who is following along is exactly the kind
    // of motion the reduced-motion setting exists to stop.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  }, [current]);

  if (!watching.active) {
    return (
      <main id="panel-video" role="tabpanel" aria-labelledby="tab-video">
        <p className="panel-empty">Nothing is playing right now.</p>
      </main>
    );
  }

  return (
    <main id="panel-video" role="tabpanel" aria-labelledby="tab-video" className="nw-pane">
      <div className="nw-head">
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

      {!segments && status !== 'none' && (
        <button type="button" className="nw-load" disabled={status === 'loading'} onClick={() => void load()}>
          {status === 'loading' ? 'Loading transcript…' : 'Follow the transcript'}
        </button>
      )}
      {status === 'none' && <p className="panel-empty">{error}</p>}

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
    </main>
  );
}

function stamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

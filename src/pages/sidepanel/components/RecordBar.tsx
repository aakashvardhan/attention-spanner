import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../shared/components/ui';
import { useActiveTab } from '../../../shared/hooks/useActiveTab';
import { useSessionValue } from '../../../shared/hooks/useSessionValue';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { sendMessage } from '../../../shared/messages';
import { formatTimestamp, type RecordingSource } from '../../../shared/recordings';
import { isYouTubeWatchUrl } from '../../../shared/youtube';

/**
 * Recording controls for the tab you are looking at, asked in the user's terms:
 * is this a meeting, a class lecture, or a YouTube video? Purpose picks the
 * audio source and tailors the summary, so the plumbing (mic vs tab vs both)
 * never has to be the question.
 *
 * This lives in the side panel, not the dashboard, for a hard technical reason:
 * chrome.tabCapture.getMediaStreamId only works on a tab the extension has been
 * invoked on, and clicking the toolbar icon IS that invocation. The panel then
 * stays open across tab switches, so the invocation and the tab shown here can
 * drift apart — capture fails with a message from Chrome, which the error row
 * below surfaces verbatim rather than guessing at.
 *
 * A YouTube tab never records audio: YouTube already transcribed the video, so
 * the chip imports its caption track instead — free, exact, instant.
 */

/** What the recording is listening to, in words the row can afford. */
function sourceLabel(source: RecordingSource): string {
  switch (source.kind) {
    case 'mic':
      return 'Microphone';
    case 'tab':
      return source.tabTitle.trim() || 'This tab';
    case 'mixed':
      return 'Tab + microphone';
    default:
      return '';
  }
}

/** Ticks once a second; always computed from the start time, so it can't drift. */
function useElapsedSeconds(startedAt: number | undefined): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === undefined ? 0 : Math.max(0, Math.round((now - startedAt) / 1000));
}

export function RecordBar({
  activeOnly = false,
  onOpenLive,
}: {
  activeOnly?: boolean;
  onOpenLive?: () => void;
} = {}) {
  const [activeRecording] = useSessionValue('activeRecording');
  const [recordings] = useStorageValue('recordings');
  const tab = useActiveTab();
  const [expanded, setExpanded] = useState(false);
  const [lectureFromTab, setLectureFromTab] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imported, setImported] = useState(false);
  const [captured, setCaptured] = useState(false);
  const capturedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Set when this panel pressed Stop, so the idle bar can confirm the save
  const [stoppedId, setStoppedId] = useState('');

  useEffect(() => () => clearTimeout(capturedTimer.current), []);

  const recording = activeRecording !== null;
  const url = tab?.url ?? '';
  const capturable = /^https?:/i.test(url);
  const isYouTube = capturable && isYouTubeWatchUrl(url);

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError('');
    try {
      const res = await action();
      if (!res.ok) setError(res.error ?? 'That did not work.');
      else setExpanded(false);
      return res.ok;
    } finally {
      setBusy(false);
    }
  };

  const startMeeting = () =>
    // The call you're in plus your own voice; plain mic when nothing capturable
    void run(async () =>
      sendMessage({
        type: 'REC_START',
        mode: capturable ? 'mixed' : 'mic',
        tabId: tab?.id,
        title: capturable ? tab?.title : undefined,
        purpose: 'meeting',
      }),
    );

  const startLecture = () =>
    // In-person default is the mic; an online lecture is the tab's audio alone —
    // your voice isn't part of the lecture, so never 'mixed' here
    void run(async () =>
      sendMessage({
        type: 'REC_START',
        mode: lectureFromTab && capturable ? 'tab' : 'mic',
        tabId: tab?.id,
        title: lectureFromTab && capturable ? tab?.title : undefined,
        purpose: 'lecture',
      }),
    );

  const importCaptions = async () => {
    const ok = await run(async () => sendMessage({ type: 'REC_YOUTUBE_IMPORT', url }));
    if (ok) setImported(true);
  };

  const captureSlide = async () => {
    const ok = await run(async () => sendMessage({ type: 'REC_CAPTURE_NOW' }));
    if (!ok) return;
    setCaptured(true);
    clearTimeout(capturedTimer.current);
    capturedTimer.current = setTimeout(() => setCaptured(false), 1500);
  };

  const elapsed = useElapsedSeconds(activeRecording?.startedAt);

  if (recording) {
    const active = recordings.find((r) => r.id === activeRecording.id);
    // Stop was pressed: capture is winding down while segments still transcribe
    const finishing = active?.status === 'transcribing';
    const segmentCount = active?.segments.length ?? 0;
    const canCapture =
      !finishing &&
      (activeRecording.source.kind === 'tab' || activeRecording.source.kind === 'mixed');

    return (
      <div className="record-bar record-bar--stack">
        <div className="record-bar-row">
          <span className="record-live">
            <span className={finishing ? 'record-dot record-dot--paused' : 'record-dot'} aria-hidden="true" />
            <span className="record-timer">{formatTimestamp(elapsed)}</span>
            <span className="record-label">{sourceLabel(activeRecording.source)}</span>
          </span>
          <Button
            variant="primary"
            disabled={busy || finishing}
            onClick={() => {
              setStoppedId(activeRecording.id);
              void run(async () => sendMessage({ type: 'REC_STOP' }));
            }}
          >
            Stop
          </Button>
        </div>
        {onOpenLive && !finishing && (
          <button className="record-live-open" type="button" onClick={onOpenLive}>
            Open live assistant
          </button>
        )}
        <div className="record-bar-row">
          <span className="record-progress" aria-live="polite">
            {finishing
              ? 'Finishing transcription…'
              : segmentCount > 0
                ? `${segmentCount} segment${segmentCount === 1 ? '' : 's'} transcribed`
                : 'First text lands a few minutes in'}
          </span>
          {canCapture && (
            <button
              className="record-capture"
              disabled={busy || captured}
              title="Describe what's on screen right now into the notes"
              aria-live="polite"
              onClick={() => void captureSlide()}
            >
              {captured ? 'Captured' : 'Capture slide'}
            </button>
          )}
        </div>
        {error && <span className="record-error">{error}</span>}
      </div>
    );
  }

  const stopped = stoppedId ? recordings.find((r) => r.id === stoppedId) : undefined;
  const idleLabel = stopped
    ? stopped.status === 'failed'
      ? stopped.error || 'Recording failed.'
      : 'Saved to Recordings — see your dashboard'
    : imported
      ? 'Captions imported — see Recordings on your dashboard'
      : 'Record & transcribe';

  if (activeOnly) return null;

  return (
    <div className="record-bar record-bar--stack">
      <div className="record-bar-row">
        {error ? (
          <span className="record-error" title={error}>
            {error}
          </span>
        ) : (
          <span
            className={stopped?.status === 'failed' ? 'record-error' : 'record-label'}
            aria-live="polite"
          >
            {idleLabel}
          </span>
        )}
        <Button
          variant="tinted"
          disabled={busy}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          Record
        </Button>
      </div>

      {expanded && (
        <>
          <div className="bookmark-picker-groups">
            <button
              className="bookmark-chip"
              disabled={busy}
              title={
                capturable
                  ? 'Record this tab and your microphone — the call plus your voice'
                  : 'Record your microphone'
              }
              onClick={startMeeting}
            >
              Meeting
            </button>
            <button
              className="bookmark-chip"
              disabled={busy}
              title={
                lectureFromTab && capturable
                  ? "Record this tab's audio — an online lecture"
                  : 'Record your microphone — an in-person lecture'
              }
              onClick={startLecture}
            >
              Class lecture
            </button>
            <button
              className="bookmark-chip"
              disabled={busy || !isYouTube}
              title={
                isYouTube
                  ? "Import this video's captions — free, no audio recorded"
                  : 'Open the YouTube video tab first, or pick a half-watched video from the dashboard'
              }
              onClick={() => void importCaptions()}
            >
              YouTube video
            </button>
          </div>
          {capturable && !isYouTube && (
            <label className="record-toggle">
              <input
                type="checkbox"
                checked={lectureFromTab}
                onChange={(e) => setLectureFromTab(e.target.checked)}
              />
              Online lecture — record this tab instead of the mic
            </label>
          )}
        </>
      )}
    </div>
  );
}

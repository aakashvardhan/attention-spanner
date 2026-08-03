import { useEffect, useMemo, useState } from 'react';
import { Button, EmptyState, Panel } from '../../shared/components/ui';
import { useSessionValue } from '../../shared/hooks/useSessionValue';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import { recordingReaderUrl } from '../../shared/pdf';
import { belongsInContinue, progressKind } from '../../shared/progress';
import { formatTimestamp, type Recording } from '../../shared/recordings';

/**
 * Recording library, plus the start flow asked in the user's terms: meeting,
 * class lecture, or YouTube video.
 *
 * Meeting and lecture record the microphone here — tab capture needs the
 * extension to have been invoked on the captured tab, and the dashboard is by
 * definition a different tab; hybrid meetings start from the side panel instead.
 *
 * The YouTube choice records nothing: it lists your half-watched videos (the
 * same query the Continue card runs) and one click resumes the video where you
 * left off AND imports its captions as a transcript — the resume machinery and
 * the caption importer both already existed, this is just the join.
 */

/** Ready with text but no summary: the summarize call was interrupted or is
 *  still running — either way "Summarize" (below) is the way through. */
function needsSummary(recording: Recording): boolean {
  return (
    recording.status === 'ready' && recording.segments.length > 0 && recording.summary === ''
  );
}

function statusLabel(recording: Recording, now: number): string {
  switch (recording.status) {
    case 'recording':
      return `recording · ${formatTimestamp((now - recording.startedAt) / 1000)}`;
    case 'transcribing':
      return 'transcribing…';
    case 'failed':
      return 'failed';
    default:
      return needsSummary(recording)
        ? 'summarizing…'
        : formatTimestamp(recording.durationSeconds);
  }
}

type Choice = 'closed' | 'purpose' | 'youtube';

export function RecordingsPanel() {
  const [recordings] = useStorageValue('recordings');
  const [readingProgress] = useStorageValue('readingProgress');
  const [activeRecording] = useSessionValue('activeRecording');
  const [choice, setChoice] = useState<Choice>('closed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [renamingId, setRenamingId] = useState('');
  const [draftTitle, setDraftTitle] = useState('');

  const recording = activeRecording !== null;

  // Same membership test as the Continue card, narrowed to videos
  const now = Date.now();
  const halfWatched = useMemo(
    () =>
      Object.values(readingProgress)
        .filter((p) => progressKind(p) === 'video' && belongsInContinue(p, now))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 5),
    // `now` is deliberately not a dependency — it's a render-time clock
    [readingProgress],
  );

  // The live row's timer. Only ticks while something records, so an idle
  // dashboard schedules nothing.
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const run = async (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError('');
    try {
      const res = await action();
      if (!res.ok) setError(res.error ?? 'That did not work.');
      else setChoice('closed');
    } finally {
      setBusy(false);
    }
  };

  const startMic = (purpose: 'meeting' | 'lecture') =>
    void run(async () => sendMessage({ type: 'REC_START', mode: 'mic', purpose }));

  /** Resume playback where it left off AND land its captions as a transcript. */
  const resumeAndImport = (url: string) =>
    void run(async () => {
      await sendMessage({ type: 'OPEN_ARTICLE', url, feedItemId: null, resume: true });
      return sendMessage({ type: 'REC_YOUTUBE_IMPORT', url });
    });

  const beginRename = (r: Recording) => {
    setRenamingId(r.id);
    setDraftTitle(r.title);
  };

  const commitRename = async () => {
    const id = renamingId;
    const title = draftTitle.trim();
    setRenamingId('');
    if (!id || !title) return;
    await sendMessage({ type: 'REC_RENAME', id, title });
  };

  const recent = recordings.slice(0, 4);

  return (
    <Panel title="Recordings">
      {recent.length === 0 ? (
        <EmptyState>
          Record a lecture or meeting and it becomes a searchable, highlightable transcript.
        </EmptyState>
      ) : (
        <div className="rec-list">
          {recent.map((r) => (
            <div className="rec-row" key={r.id}>
              {renamingId === r.id ? (
                <input
                  className="rec-rename-input"
                  value={draftTitle}
                  autoFocus
                  aria-label="Recording title"
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename();
                    if (e.key === 'Escape') setRenamingId('');
                  }}
                />
              ) : (
                <>
                  <button
                    className="rec-row-open"
                    onClick={() => void chrome.tabs.create({ url: recordingReaderUrl(r.id) })}
                    title={r.error || r.title}
                  >
                    <span className="rec-row-title">{r.title}</span>
                    <span
                      className={r.status === 'failed' ? 'rec-row-meta failed' : 'rec-row-meta'}
                    >
                      {statusLabel(r, tick)}
                    </span>
                  </button>
                  {needsSummary(r) && (
                    <button
                      className="rec-row-action"
                      title="Write the summary from the finished transcript"
                      onClick={() => void sendMessage({ type: 'REC_SUMMARIZE', id: r.id })}
                    >
                      Summarize
                    </button>
                  )}
                  <button
                    className="rec-row-action"
                    title="Rename this recording"
                    aria-label={`Rename ${r.title}`}
                    onClick={() => beginRename(r)}
                  >
                    Rename
                  </button>
                  <button
                    className="rec-row-delete"
                    title="Delete this recording"
                    aria-label={`Delete ${r.title}`}
                    onClick={() => void sendMessage({ type: 'REC_DELETE', id: r.id })}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p className="rec-error">{error}</p>}

      {choice === 'purpose' && !recording && (
        <div className="rec-choices">
          <button className="dash-feed-toggle" disabled={busy} onClick={() => startMic('meeting')}>
            Meeting
          </button>
          <button className="dash-feed-toggle" disabled={busy} onClick={() => startMic('lecture')}>
            Class lecture
          </button>
          <button
            className="dash-feed-toggle"
            disabled={busy}
            onClick={() => setChoice('youtube')}
          >
            YouTube video
          </button>
        </div>
      )}

      {choice === 'youtube' && !recording && (
        <div className="rec-list">
          {halfWatched.length === 0 ? (
            <p className="rec-hint">
              No half-watched videos — start one on YouTube, or use the side panel on a video tab.
            </p>
          ) : (
            halfWatched.map((p) => (
              <div className="rec-row" key={p.url}>
                <button
                  className="rec-row-open"
                  disabled={busy}
                  title="Resume where you left off and import the captions"
                  onClick={() => resumeAndImport(p.url)}
                >
                  <span className="rec-row-title">{p.title || p.url}</span>
                  <span className="rec-row-meta">{p.maxPercent}%</span>
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <Button
        variant={recording ? 'primary' : 'tinted'}
        block
        disabled={busy}
        onClick={() => {
          if (recording) void run(async () => sendMessage({ type: 'REC_STOP' }));
          else setChoice((c) => (c === 'closed' ? 'purpose' : 'closed'));
        }}
      >
        {recording ? 'Stop recording' : choice === 'closed' ? 'Record' : 'Cancel'}
      </Button>
    </Panel>
  );
}

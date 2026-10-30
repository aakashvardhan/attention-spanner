import { useEffect, useState } from 'react';
import type { ResumableItem } from '../../shared/attention';
import { AiNote } from '../../shared/components/AiNote';
import { formatRelativeDate, formatWatchTime } from '../../shared/format';
import { useAi } from '../../shared/hooks/useAi';
import { useSettings } from '../../shared/hooks/useSettings';
import { GEMINI_MODEL, geminiVideoStream } from '../../shared/llm/gemini';
import { cachedAi } from '../../shared/llm/generate';
import { recapRequest, videoSummaryRequest, wantsRecap } from '../../shared/llm/recap';
import { recordStat } from '../../shared/llm/store';
import { sendMessage } from '../../shared/messages';
import { paceLabel, paceMinutesLeft, progressKeyFor } from '../../shared/progress';
import type { VideoProgress } from '../../shared/types';
import { isWatchingNow, livePositionSeconds } from '../../shared/youtube';
import { Icon } from './Icon';

/** The lead story's status line: where you are, in the unit the thing has. */
export function leadStatus(item: ResumableItem): string {
  const { paper, progress } = item;
  if (paper) {
    if (!paper.pdf) return `${Math.round(paper.progressPercent)}% read`;
    const page = `Page ${paper.pdf.page} of ${paper.pdf.pageCount}`;
    return paper.leftOff ? `${page} · ${paper.leftOff}` : page;
  }
  if (progress?.kind === 'video') {
    return `${formatWatchTime(progress.positionSeconds)} of ${formatWatchTime(progress.durationSeconds)}`;
  }
  const opened = formatRelativeDate(new Date(item.updatedAt)).replace(/^Just now$/, 'just now');
  const pace = progress ? paceLabel(paceMinutesLeft(progress)) : '';
  return [`${Math.round(progress?.maxPercent ?? 0)}% read`, `opened ${opened}`, pace].filter(Boolean).join(' · ');
}

export function kickerFor(item: ResumableItem): string {
  if (item.paper) return 'Continue reading · paper';
  return item.progress?.kind === 'video' ? 'Continue watching · video' : 'Continue reading · article';
}

/**
 * One "Pick something back up" row, with a Recap control when there is
 * something to recap. Collapsed by default: six rows of bullets would bury the
 * list, and the recap is for the one you are about to open.
 *
 * Videos can be recapped from here, since their transcript is fetchable from
 * the new tab, and summarized whole, watched or not. Articles and papers only
 * exist as text inside the reader, so the row offers the recap the reader made
 * on your last visit, if any.
 */
export function ContinueRow({
  item,
  now,
  onOpen,
  lead = false,
  selected = false,
}: {
  item: ResumableItem;
  now: number;
  /** The front-page lead story: kicker, headline, status and the one primary action. */
  lead?: boolean;
  /** Where J/K selection sits; Enter with nothing focused opens it. */
  selected?: boolean;
  /** `alt`: Option/Alt held, so an arXiv paper opens on alphaXiv instead of the reader; `newTab`: ⌘/Ctrl held. */
  onOpen: (alt: boolean, newTab: boolean) => void;
}) {
  const ai = useAi();
  /** Which answer is unfolded under the row; the two share one AI call slot. */
  const [panel, setPanel] = useState<'recap' | 'summary' | null>(null);
  const [saved, setSaved] = useState(false);
  /** Why the transcript couldn't be read, when it couldn't */
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [settings] = useSettings();

  const progressKey = item.paper ? `paper:${item.paper.id}` : item.progress ? progressKeyFor(item.progress.url) : '';
  const percent = item.paper ? item.paper.progressPercent : (item.progress?.maxPercent ?? 0);
  const pace = item.progress ? paceMinutesLeft(item.progress) : null;
  const video: VideoProgress | null = item.progress?.kind === 'video' ? item.progress : null;
  const eligible = wantsRecap(percent);

  // A recap saved at this progress band (the cache key ignores the passages).
  const savedRequest = recapRequest({ key: progressKey, passages: [], percent, source: 'web' });
  useEffect(() => {
    if (!eligible || video) return;
    let alive = true;
    void cachedAi(savedRequest).then((hit) => alive && setSaved(hit !== null));
    return () => {
      alive = false;
    };
    // savedRequest is derived from the cache key.
  }, [eligible, video === null, savedRequest.cacheKey]);

  const showRecap = async () => {
    setPanel('recap');
    if (!video) {
      void ai.showCached(savedRequest);
      return;
    }
    setTranscriptError(null);
    const res = await videoPassages(video);
    if ('error' in res) {
      setTranscriptError(`${res.error} Open the video in a tab and try again.`);
      return;
    }
    void ai.start(recapRequest({ key: progressKey, passages: res.passages, percent, source: 'youtube' }));
  };

  const showSummary = async () => {
    setPanel('summary');
    if (!video) return;
    setTranscriptError(null);
    const res = await videoPassages(video);
    if ('passages' in res) {
      void ai.start(videoSummaryRequest({ key: progressKey, passages: res.passages }));
      return;
    }
    // No transcript here: Gemini can watch the public video itself.
    if (settings.geminiKey) {
      const request = videoSummaryRequest({ key: progressKey, passages: [] });
      void ai.startWith(
        request,
        { target: 'gemini', model: GEMINI_MODEL, reason: 'No transcript here · Gemini watched the video' },
        (signal, onText) =>
          geminiVideoStream({
            apiKey: settings.geminiKey,
            videoUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
            system: request.system,
            prompt: request.prompt,
            signal,
            onText,
          }),
      );
      return;
    }
    setTranscriptError(`${res.error} Open it in a tab, or add a Gemini API key in Settings to summarize it without one.`);
  };

  const toggle = (which: 'recap' | 'summary') => {
    if (panel === which) {
      ai.dismiss();
      setPanel(null);
    } else {
      void (which === 'recap' ? showRecap() : showSummary());
    }
  };

  const canRecap = eligible && (video !== null || saved);

  return (
    <li>
      <div className="relay-row-wrap">
        <button
          className={lead ? 'edition-lead' : 'relay-row'}
          data-story
          aria-current={selected || undefined}
          onClick={(e) => {
            // A reader-opened document re-records this probe with what it
            // showed; the row's answer stands for everything else.
            void recordStat({
              probe: {
                key: progressKey,
                startPercent: percent,
                recap: panel === 'recap' && ai.view.status === 'done',
                at: Date.now(),
              },
            });
            onOpen(e.altKey, e.metaKey || e.ctrlKey);
          }}
        >
          {lead ? (
            <span className="edition-lead-text">
              <span className="edition-kicker">{kickerFor(item)}</span>
              <span className="edition-headline">{item.title}</span>
              <span className="edition-lead-status">{leadStatus(item)}</span>
              <span className="relay-row-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
                {pace !== null && (
                  <span className="relay-row-forecast" style={{ left: `${Math.min(100, Math.max(0, percent))}%` }} />
                )}
              </span>
              <span className="edition-cta">
                Pick it back up <kbd>Enter</kbd>
              </span>
            </span>
          ) : (
            <span className="relay-row-text">
              <span className="relay-row-title">{item.title}</span>
              <small className="relay-row-meta">
                {[item.paper ? item.paper.venue || 'Paper' : item.progress?.source, `${Math.round(percent)}%`]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
              <span className="relay-row-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
                {pace !== null && (
                  <span className="relay-row-forecast" style={{ left: `${Math.min(100, Math.max(0, percent))}%` }} />
                )}
              </span>
            </span>
          )}
          {/* A video playing in another tab is context, so it marks the
              row it already occupies rather than earning a card. */}
          {item.progress && isWatchingNow(item.progress, now) && (
            <small className="relay-watching">
              Watching · {formatWatchTime(livePositionSeconds(item.progress, now))}
            </small>
          )}
          <Icon name="chevron" className="relay-row-chevron" />
        </button>
        {video && (
          <button
            type="button"
            className="relay-recap-toggle"
            aria-expanded={panel === 'summary'}
            aria-label={panel === 'summary' ? 'Hide summary' : 'Summarize the whole video'}
            onClick={() => toggle('summary')}
          >
            {panel === 'summary' ? 'Hide' : 'Summary'}
          </button>
        )}
        {canRecap && (
          <button
            type="button"
            className="relay-recap-toggle"
            aria-expanded={panel === 'recap'}
            onClick={() => toggle('recap')}
          >
            {panel === 'recap' ? 'Hide' : 'Recap'}
          </button>
        )}
        <button
          type="button"
          className="relay-remove"
          aria-label={`Remove ${item.title} from Continue`}
          title="Remove from Continue"
          onClick={() => void removeFromContinue(item)}
        >
          <Icon name="close" />
        </button>
      </div>
      {panel && (
        <div className="relay-recap">
          {transcriptError ? (
            <p className="relay-empty">{transcriptError}</p>
          ) : (
            <AiNote view={ai.view} onStop={ai.stop} onApprove={ai.approve} onDismiss={() => setPanel(null)} />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The whole transcript, one passage per caption block. recapRequest cuts it at
 * the furthest point watched, the same way it cuts an article.
 */
async function videoPassages(video: VideoProgress): Promise<{ passages: string[] } | { error: string }> {
  try {
    const res = await sendMessage({ type: 'VIDEO_TRANSCRIPT', videoId: video.videoId });
    if (!res.ok || !res.segments?.length) return { error: res.error ?? 'This video has no transcript.' };
    return { passages: res.segments.map((s) => s.text) };
  } catch {
    return { error: 'Could not ask for the transcript.' };
  }
}

/**
 * The X on a row. An article or video forgets its progress. A paper only steps
 * back to "to read": it lives in a deck in your library, and its place in the
 * PDF is kept for when you open it again.
 */
function removeFromContinue(item: ResumableItem) {
  if (item.paper) return sendMessage({ type: 'PAPER_UPDATE', id: item.paper.id, patch: { status: 'to-read' } });
  if (item.progress) return sendMessage({ type: 'PROGRESS_DELETE', url: item.progress.url });
}

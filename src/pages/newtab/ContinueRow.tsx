import { useEffect, useState } from 'react';
import type { ResumableItem } from '../../shared/attention';
import { AiNote } from '../../shared/components/AiNote';
import { formatWatchTime } from '../../shared/format';
import { useAi } from '../../shared/hooks/useAi';
import { cachedAi } from '../../shared/llm/generate';
import { recapRequest, videoSummaryRequest, wantsRecap } from '../../shared/llm/recap';
import { sendMessage } from '../../shared/messages';
import { progressKeyFor } from '../../shared/progress';
import type { VideoProgress } from '../../shared/types';
import { isWatchingNow, livePositionSeconds } from '../../shared/youtube';
import { Icon } from './Icon';

/** The row's right-hand metadata: where you are, in the unit the thing has. */
export function rowMeta(item: ResumableItem): string {
  const { paper, progress } = item;
  if (paper?.pdf) return `p. ${paper.pdf.page}`;
  if (progress?.kind === 'video') return formatWatchTime(progress.positionSeconds);
  return `${Math.round(paper ? paper.progressPercent : (progress?.maxPercent ?? 0))}%`;
}

/**
 * One Continue row: title on the left, where you are on the right, and a
 * Recap control when there is something to recap. Collapsed by default: six
 * rows of bullets would bury the list, and the recap is for the one you are
 * about to open.
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
}: {
  item: ResumableItem;
  now: number;
  /** `alt`: Option/Alt held, so an arXiv paper opens on alphaXiv instead of the reader; `newTab`: ⌘/Ctrl held. */
  onOpen: (alt: boolean, newTab: boolean) => void;
}) {
  const ai = useAi();
  /** Which answer is unfolded under the row; the two share one AI call slot. */
  const [panel, setPanel] = useState<'recap' | 'summary' | null>(null);
  const [saved, setSaved] = useState(false);
  /** Why the transcript couldn't be read, when it couldn't */
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const progressKey = item.paper ? `paper:${item.paper.id}` : item.progress ? progressKeyFor(item.progress.url) : '';
  const percent = item.paper ? item.paper.progressPercent : (item.progress?.maxPercent ?? 0);
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
    setTranscriptError(`${res.error} Open it in a tab and try again.`);
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

  const watching = item.progress && isWatchingNow(item.progress, now) ? item.progress : null;

  return (
    <li>
      <div className="row-wrap">
        <button className="row" data-story onClick={(e) => onOpen(e.altKey, e.metaKey || e.ctrlKey)}>
          <span className="row-title">{item.title}</span>
          {/* A video playing in another tab is state, so it marks the row it already occupies. */}
          {watching && <span className="row-state">watching</span>}
          <span className="row-meta">{watching ? formatWatchTime(livePositionSeconds(watching, now)) : rowMeta(item)}</span>
        </button>
        <span className="row-tools">
          {video && (
            <button
              type="button"
              className="row-tool"
              aria-expanded={panel === 'summary'}
              aria-label={panel === 'summary' ? 'Hide summary' : 'Summarize the whole video'}
              onClick={() => toggle('summary')}
            >
              {panel === 'summary' ? 'Hide' : 'Summary'}
            </button>
          )}
          {canRecap && (
            <button type="button" className="row-tool" aria-expanded={panel === 'recap'} onClick={() => toggle('recap')}>
              {panel === 'recap' ? 'Hide' : 'Recap'}
            </button>
          )}
          <button
            type="button"
            className="row-remove"
            aria-label={`Remove ${item.title} from Continue`}
            title="Remove from Continue"
            onClick={() => void removeFromContinue(item)}
          >
            <Icon name="close" className="row-remove-icon" />
          </button>
        </span>
      </div>
      {panel && (
        <div className="row-recap">
          {transcriptError ? (
            <p className="hint">{transcriptError}</p>
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

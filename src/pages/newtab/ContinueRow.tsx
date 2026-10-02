import { useEffect, useState } from 'react';
import type { ResumableItem } from '../../shared/attention';
import { AiNote } from '../../shared/components/AiNote';
import { formatRelativeDate, formatWatchTime } from '../../shared/format';
import { useAi } from '../../shared/hooks/useAi';
import { cachedAi } from '../../shared/llm/generate';
import { recapRequest, wantsRecap } from '../../shared/llm/recap';
import { recordStat } from '../../shared/llm/store';
import { sendMessage } from '../../shared/messages';
import { progressKeyFor } from '../../shared/progress';
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
  return `${Math.round(progress?.maxPercent ?? 0)}% read · opened ${opened}`;
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
 * the new tab. Articles and papers only exist as text inside the reader, so
 * the row offers the recap the reader made on your last visit, if any.
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
  /** `alt`: Option/Alt was held, so a paper opens in the reader instead of alphaXiv. */
  onOpen: (alt: boolean) => void;
}) {
  const ai = useAi();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [noTranscript, setNoTranscript] = useState(false);

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
    setOpen(true);
    if (!video) {
      void ai.showCached(savedRequest);
      return;
    }
    const passages = await videoPassages(video);
    if (passages === null) {
      setNoTranscript(true);
      return;
    }
    void ai.start(recapRequest({ key: progressKey, passages, percent, source: 'youtube' }));
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
                recap: open && ai.view.status === 'done',
                at: Date.now(),
              },
            });
            onOpen(e.altKey);
          }}
        >
          {lead ? (
            <span className="edition-lead-text">
              <span className="edition-kicker">{kickerFor(item)}</span>
              <span className="edition-headline">{item.title}</span>
              <span className="edition-lead-status">{leadStatus(item)}</span>
              <span className="relay-row-meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
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
        {canRecap && (
          <button
            type="button"
            className="relay-recap-toggle"
            aria-expanded={open}
            onClick={() => (open ? (ai.dismiss(), setOpen(false)) : void showRecap())}
          >
            {open ? 'Hide' : 'Recap'}
          </button>
        )}
      </div>
      {open && (
        <div className="relay-recap">
          {noTranscript ? (
            <p className="relay-empty">This video has no transcript to recap from.</p>
          ) : (
            <AiNote view={ai.view} onStop={ai.stop} onApprove={ai.approve} onDismiss={() => setOpen(false)} />
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
async function videoPassages(video: VideoProgress): Promise<string[] | null> {
  try {
    const res = await sendMessage({ type: 'VIDEO_TRANSCRIPT', videoId: video.videoId });
    if (!res.ok || !res.segments?.length) return null;
    return res.segments.map((s) => s.text);
  } catch {
    return null;
  }
}

import { useEffect, useRef, useState } from 'react';
import { useActiveTab } from '../../shared/hooks/useActiveTab';
import { useFocusSession } from '../../shared/hooks/useFocusSession';
import { useNowWatching } from '../../shared/hooks/useNowWatching';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import { useTheme } from '../../shared/hooks/useTheme';
import { DEFAULT_SETTINGS } from '../../shared/storage';
import { BookmarkPicker } from './components/BookmarkPicker';
import { NowWatching } from './components/NowWatching';

function pageContext(tab: chrome.tabs.Tab | null): { title: string; detail: string } {
  if (!tab) return { title: 'Current page', detail: 'Waiting for the active tab' };
  const title = tab.title?.trim() || 'Untitled page';
  try {
    const url = new URL(tab.url ?? '');
    return {
      title,
      detail: url.protocol === 'chrome-extension:' ? 'Reader' : url.hostname.replace(/^www\./, ''),
    };
  } catch {
    return { title, detail: 'Current tab' };
  }
}

/**
 * The side panel acts on the page you are looking at: read it, bookmark it,
 * start a focus block — plus a Follow pane for whatever video is playing.
 *
 * It had tabs for chat, tasks and notes. Those features are gone, so the tab
 * bar went with them rather than being kept for one destination.
 */
export function SidePanel() {
  useTheme();
  const activeTab = useActiveTab();
  const context = pageContext(activeTab);
  const [following, setFollowing] = useState(false);
  const [pickingBookmark, setPickingBookmark] = useState(false);
  const actionsRef = useRef<HTMLDetailsElement>(null);

  const focus = useFocusSession();
  const watching = useNowWatching();
  const [storedSettings] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  useEffect(() => {
    if (!watching.active) setFollowing(false);
  }, [watching.active]);

  const closeActions = () => {
    actionsRef.current?.removeAttribute('open');
    setPickingBookmark(false);
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) closeActions();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeActions();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  });

  return (
    <div className="container">
      <div className="panel-chrome">
        <header className="context-header">
          <div className="context-copy">
            <h1 title={context.title}>{context.title}</h1>
            <p>{context.detail}</p>
          </div>

          <details className="panel-actions-menu" ref={actionsRef}>
            <summary>Actions</summary>
            <div className="panel-actions-popover">
              {activeTab?.url && /^https?:/.test(activeTab.url) && (
                <button
                  type="button"
                  onClick={() => {
                    void sendMessage({
                      type: 'OPEN_ARTICLE',
                      url: activeTab.url!,
                      feedItemId: null,
                      readerView: true,
                    });
                    closeActions();
                  }}
                >
                  Read this page
                </button>
              )}
              <button type="button" onClick={() => setPickingBookmark((current) => !current)}>
                Bookmark this page
              </button>
              {!focus.active && (
                <button
                  type="button"
                  onClick={() => {
                    void focus.start({
                      mode: 'oneshot',
                      focusMinutes: settings.focusMinutes,
                      breakMinutes: 0,
                    });
                    closeActions();
                  }}
                >
                  Start {settings.focusMinutes}-minute focus
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  void chrome.runtime.openOptionsPage();
                  closeActions();
                }}
              >
                Settings
              </button>

              {pickingBookmark && <BookmarkPicker onDone={closeActions} />}
            </div>
          </details>
        </header>

        {focus.active && (
          <div className="active-status-row">
            <span>
              <strong>{focus.phase === 'focus' ? 'Focus' : 'Break'}</strong>
              <small>{focus.countdown}</small>
            </span>
            <button type="button" onClick={() => void focus.stop(true)}>
              Stop
            </button>
          </div>
        )}
        {/* Same row shape focus uses, so it needs no CSS of its own. No
            aria-live: the clock ticks twice a second and a live region here
            would talk over everything else in the panel. */}
        {watching.active && !following && (
          <div className="active-status-row now-watching">
            <span>
              <strong title={watching.video.title}>{watching.video.title}</strong>
              <small>
                {watching.position} / {watching.duration}
                {watching.chapter && ` · ${watching.chapter}`}
              </small>
            </span>
            <button type="button" onClick={() => setFollowing(true)}>
              Follow
            </button>
          </div>
        )}
      </div>

      {watching.active && following ? (
        <>
          <div className="secondary-pane-head">
            <button type="button" onClick={() => setFollowing(false)}>
              ‹ Back
            </button>
            <div>
              <h2>Now watching</h2>
              <p>Follow along with this video</p>
            </div>
            <button
              type="button"
              onClick={() =>
                void sendMessage({
                  type: 'FOCUS_VIDEO_TAB',
                  videoId: watching.video?.videoId ?? '',
                })
              }
            >
              Open tab
            </button>
          </div>
          <NowWatching />
        </>
      ) : (
        <main className="panel-idle">
          <p>Use Actions above to read, bookmark, or focus.</p>
        </main>
      )}
    </div>
  );
}

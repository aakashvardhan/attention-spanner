import { useEffect, useRef, useState } from 'react';
import { HYPERFOCUS_MINUTES, SAMPLE_FEEDS } from '../../shared/constants';
import { normalizeBlockDomain } from '../../shared/focusRules';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { sendMessage } from '../../shared/messages';
import { getLocal, patchSettings, setLocal } from '../../shared/storage';
import type { ThemeSetting } from '../../shared/types';
import { LocalAiSection } from './LocalAiSection';
import { NewTabSection } from './NewTabSection';
import { PapersSection } from './PapersSection';

type Feedback = { text: string; kind: 'success' | 'error' | 'loading' } | null;

export function Options() {
  useTheme();
  const [feeds] = useStorageValue('feeds');
  const [settings, settingsLoaded] = useSettings();

  const [url, setUrl] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const [notificationsBlocked, setNotificationsBlocked] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [blockInput, setBlockInput] = useState('');
  const [blockFeedback, setBlockFeedback] = useState<string | null>(null);

  useEffect(() => {
    chrome.notifications.getPermissionLevel((level) => {
      setNotificationsBlocked(level === 'denied');
    });
  }, []);

  /* Scroll-edge effect: the header takes its material only once the page has
     scrolled under it. An IntersectionObserver on a zero-height sentinel rather
     than a scroll listener, so idle frames cost nothing. The flag lands on
     <body> because the header is a direct child of the page, not of a pane. */
  useEffect(() => {
    // Keyed on settingsLoaded, not []: the page renders null until settings
    // arrive, so on the first pass the sentinel is not in the DOM yet and an
    // effect with no deps would attach to nothing and never run again.
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        document.body.dataset.scrolled = String(!entry.isIntersecting);
      },
      { threshold: 1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [settingsLoaded]);

  const flash = (text: string, kind: 'success' | 'error') => {
    setFeedback({ text, kind });
    setTimeout(() => setFeedback(null), 3000);
  };

  const addFeed = async (feedUrl: string) => {
    try {
      new URL(feedUrl);
    } catch {
      flash('Invalid URL format.', 'error');
      return;
    }
    if (feeds.includes(feedUrl)) {
      flash('This feed is already added.', 'error');
      return;
    }
    setFeedback({ text: 'Validating feed…', kind: 'loading' });
    const res = await sendMessage({ type: 'VALIDATE_FEED', url: feedUrl });
    if (!res?.valid) {
      flash('Could not fetch feed. Please check the URL.', 'error');
      return;
    }
    // Re-read rather than write back the list this render captured: validation
    // above is a network round-trip, so the snapshot can be stale by now.
    const { feeds: live } = await getLocal('feeds');
    if (live.includes(feedUrl)) {
      flash('This feed is already added.', 'error');
      return;
    }
    await setLocal({ feeds: [...live, feedUrl] });
    flash(res.title ? `Added "${res.title}"!` : 'Feed added successfully!', 'success');
    void sendMessage({ type: 'REFRESH_FEEDS' });
  };

  const removeFeed = async (feedUrl: string) => {
    const { feeds: live } = await getLocal('feeds');
    await setLocal({ feeds: live.filter((f) => f !== feedUrl) });
  };

  const markAllRead = async () => {
    const res = await sendMessage({ type: 'MARK_ALL_READ' });
    setDataMessage(res?.ok ? `Marked ${res.count} items as read.` : 'Failed to mark items.');
  };

  const addBlockDomain = async () => {
    const domain = normalizeBlockDomain(blockInput);
    if (!domain) {
      setBlockFeedback('Not a valid domain (e.g. netflix.com).');
      return;
    }
    if (settings.focusBlocklist.includes(domain)) {
      setBlockFeedback('Already on the list.');
      return;
    }
    setBlockInput('');
    setBlockFeedback(null);
    await patchSettings({ focusBlocklist: [...settings.focusBlocklist, domain] });
  };

  const removeBlockDomain = (domain: string) =>
    patchSettings({ focusBlocklist: settings.focusBlocklist.filter((d) => d !== domain) });

  const clearReadHistory = async () => {
    if (!window.confirm('Clear all read history? Unread counts will be recalculated.')) return;
    await setLocal({ readItems: [] });
    setDataMessage('Read history cleared.');
  };

  if (!settingsLoaded) return null;

  return (
    <div className="container">
      <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />
      <header>
        <h1>Reader Settings</h1>
      </header>

      <main>
        <section className="section">
          <h2>Appearance</h2>
          <div className="setting-row">
            <label htmlFor="theme-select">Theme</label>
            <select
              id="theme-select"
              value={settings.theme}
              onChange={(e) => void patchSettings({ theme: e.target.value as ThemeSetting })}
            >
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </section>

        <NewTabSection settings={settings} />

        <LocalAiSection settings={settings} />

        <section className="section">
          <h2>Add New Feed</h2>
          <form
            className="add-feed-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (url.trim()) {
                void addFeed(url.trim());
                setUrl('');
              }
            }}
          >
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Enter RSS feed URL (e.g., https://example.com/feed.xml)"
              required
            />
            <button type="submit">Add Feed</button>
          </form>
          {feedback && <p className={`feedback ${feedback.kind}`}>{feedback.text}</p>}
        </section>

        <section className="section">
          <h2>Your Feeds</h2>
          <div className="feeds-list">
            {feeds.length === 0 ? (
              <p className="empty-message">No feeds added yet.</p>
            ) : (
              feeds.map((feedUrl) => (
                <div className="feed-entry" key={feedUrl}>
                  <span className="feed-entry-url">{feedUrl}</span>
                  <button
                    className="remove-feed-btn"
                    title="Remove feed"
                    onClick={() => void removeFeed(feedUrl)}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="section">
          <h2>Refresh Interval</h2>
          <div className="setting-row">
            <label htmlFor="refresh-interval">Auto-refresh every:</label>
            <select
              id="refresh-interval"
              value={settings.refreshInterval}
              onChange={(e) => void patchSettings({ refreshInterval: Number(e.target.value) })}
            >
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>1 hour</option>
              <option value={120}>2 hours</option>
              <option value={360}>6 hours</option>
            </select>
          </div>
        </section>

        <section className="section">
          <h2>Notifications & Focus</h2>
          {notificationsBlocked && (
            <p className="feedback error">
              Chrome notifications are blocked at the OS level. On macOS, enable them in System
              Settings → Notifications → Google Chrome, or reminders and nudges will not appear.
            </p>
          )}
          <div className="setting-row">
            <label htmlFor="notifications-enabled">Notifications</label>
            <input
              id="notifications-enabled"
              type="checkbox"
              checked={settings.notificationsEnabled}
              onChange={(e) => void patchSettings({ notificationsEnabled: e.target.checked })}
            />
          </div>
          <div className="setting-row">
            <label htmlFor="nudges-enabled">
              Reading nudges{' '}
              <span className="hint-inline">(remind me about half-read articles)</span>
            </label>
            <input
              id="nudges-enabled"
              type="checkbox"
              checked={settings.nudgesEnabled}
              disabled={!settings.notificationsEnabled}
              onChange={(e) => void patchSettings({ nudgesEnabled: e.target.checked })}
            />
          </div>
          <div className="setting-row">
            <label htmlFor="hyperfocus-enabled">
              Hyperfocus check-in{' '}
              <span className="hint-inline">
                (break reminder after {HYPERFOCUS_MINUTES} min unbroken reading/watching)
              </span>
            </label>
            <input
              id="hyperfocus-enabled"
              type="checkbox"
              checked={settings.hyperfocusEnabled}
              disabled={!settings.notificationsEnabled}
              onChange={(e) => void patchSettings({ hyperfocusEnabled: e.target.checked })}
            />
          </div>
        </section>

        <section className="section">
          <h2>Focus Mode</h2>
          <p className="hint">Sites blocked during focus sessions:</p>
          <form
            className="add-feed-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addBlockDomain();
            }}
          >
            <input
              type="text"
              value={blockInput}
              onChange={(e) => setBlockInput(e.target.value)}
              placeholder="Add a domain to block (e.g. netflix.com)"
            />
            <button type="submit">Add</button>
          </form>
          {blockFeedback && <p className="feedback error">{blockFeedback}</p>}
          <div className="feeds-list" style={{ marginTop: 10 }}>
            {settings.focusBlocklist.map((domain) => (
              <div className="feed-entry" key={domain}>
                <span className="feed-entry-url">{domain}</span>
                <button
                  className="remove-feed-btn"
                  title="Remove from blocklist"
                  onClick={() => void removeBlockDomain(domain)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="setting-row">
            <label htmlFor="focus-music">
              Open Flowtunes focus music when a session starts
            </label>
            <input
              id="focus-music"
              type="checkbox"
              checked={settings.focusMusicEnabled}
              onChange={(e) => void patchSettings({ focusMusicEnabled: e.target.checked })}
            />
          </div>
          <div className="setting-row">
            <label htmlFor="focus-minutes">Focus length:</label>
            <select
              id="focus-minutes"
              value={settings.focusMinutes}
              onChange={(e) => void patchSettings({ focusMinutes: Number(e.target.value) })}
            >
              {[25, 45, 50, 60, 90].map((n) => (
                <option key={n} value={n}>
                  {n} min
                </option>
              ))}
            </select>
          </div>
        </section>

        <PapersSection />

        <section className="section">
          <h2>Data</h2>
          <div className="button-group">
            <button type="button" className="secondary-btn" onClick={() => void markAllRead()}>
              Mark All as Read
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => void clearReadHistory()}
            >
              Clear Read History
            </button>
          </div>
          {dataMessage && <p className="feedback success">{dataMessage}</p>}
        </section>

        <section className="section">
          <h2>Sample Feeds</h2>
          <p className="hint">Click to add popular feeds:</p>
          <div className="sample-feeds">
            {SAMPLE_FEEDS.map((feed) => (
              <button
                type="button"
                key={feed.url}
                className="sample-feed"
                onClick={() => void addFeed(feed.url)}
              >
                {feed.name}
              </button>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

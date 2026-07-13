import { useEffect, useState } from 'react';
import { SAMPLE_FEEDS } from '../../shared/constants';
import { normalizeBlockDomain } from '../../shared/focusRules';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { sendMessage } from '../../shared/messages';
import { DEFAULT_SETTINGS, patchSettings, setLocal } from '../../shared/storage';
import type { Settings, ThemeSetting } from '../../shared/types';
import { AssistantSection } from './AssistantSection';
import { PapersSection } from './PapersSection';

type Feedback = { text: string; kind: 'success' | 'error' | 'loading' } | null;

export function Options() {
  useTheme();
  const [feeds] = useStorageValue('feeds');
  const [storedSettings, settingsLoaded] = useStorageValue('settings');
  const settings: Settings = { ...DEFAULT_SETTINGS, ...storedSettings };

  const [url, setUrl] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const [notificationsBlocked, setNotificationsBlocked] = useState(false);
  const [blockInput, setBlockInput] = useState('');
  const [blockFeedback, setBlockFeedback] = useState<string | null>(null);
  const [pillInput, setPillInput] = useState('');
  const [pillFeedback, setPillFeedback] = useState<string | null>(null);

  useEffect(() => {
    chrome.notifications.getPermissionLevel((level) => {
      setNotificationsBlocked(level === 'denied');
    });
  }, []);

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
    await setLocal({ feeds: [...feeds, feedUrl] });
    flash(res.title ? `Added "${res.title}"!` : 'Feed added successfully!', 'success');
    void sendMessage({ type: 'REFRESH_FEEDS' });
  };

  const removeFeed = async (feedUrl: string) => {
    await setLocal({ feeds: feeds.filter((f) => f !== feedUrl) });
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

  const addPillHost = async () => {
    const domain = normalizeBlockDomain(pillInput);
    if (!domain) {
      setPillFeedback('Not a valid domain (e.g. youtube.com).');
      return;
    }
    if (settings.timePillHosts.includes(domain)) {
      setPillFeedback('Already on the list.');
      return;
    }
    setPillInput('');
    setPillFeedback(null);
    await patchSettings({ timePillHosts: [...settings.timePillHosts, domain] });
  };

  const removePillHost = (domain: string) =>
    patchSettings({ timePillHosts: settings.timePillHosts.filter((d) => d !== domain) });

  const clearReadHistory = async () => {
    if (!window.confirm('Clear all read history? Unread counts will be recalculated.')) return;
    await setLocal({ readItems: [] });
    setDataMessage('Read history cleared.');
  };

  if (!settingsLoaded) return null;

  return (
    <div className="container">
      <header>
        <h1>⚙️ Reader Settings</h1>
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
            <label htmlFor="task-reminder-interval">Remind me about open tasks:</label>
            <select
              id="task-reminder-interval"
              value={settings.taskReminderIntervalMinutes}
              disabled={!settings.notificationsEnabled}
              onChange={(e) =>
                void patchSettings({ taskReminderIntervalMinutes: Number(e.target.value) })
              }
            >
              <option value={0}>Never</option>
              <option value={60}>Every hour</option>
              <option value={120}>Every 2 hours</option>
              <option value={240}>Every 4 hours</option>
              <option value={480}>Every 8 hours</option>
            </select>
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
            <label htmlFor="nudge-delay">Nudge me after I've been away for:</label>
            <select
              id="nudge-delay"
              value={settings.nudgeDelayMinutes}
              disabled={!settings.notificationsEnabled || !settings.nudgesEnabled}
              onChange={(e) => void patchSettings({ nudgeDelayMinutes: Number(e.target.value) })}
            >
              <option value={1}>1 minute</option>
              <option value={3}>3 minutes</option>
              <option value={5}>5 minutes</option>
              <option value={10}>10 minutes</option>
              <option value={15}>15 minutes</option>
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="hyperfocus-minutes">
              Hyperfocus check-in{' '}
              <span className="hint-inline">(break reminder after unbroken reading/watching)</span>
            </label>
            <select
              id="hyperfocus-minutes"
              value={settings.hyperfocusMinutes}
              disabled={!settings.notificationsEnabled}
              onChange={(e) => void patchSettings({ hyperfocusMinutes: Number(e.target.value) })}
            >
              <option value={0}>Off</option>
              <option value={45}>After 45 min</option>
              <option value={60}>After 1 hour</option>
              <option value={90}>After 90 min</option>
              <option value={120}>After 2 hours</option>
            </select>
          </div>
        </section>

        <section className="section">
          <h2>Gym & Goals</h2>
          <div className="setting-row">
            <label htmlFor="gym-weekly-target">Gym sessions per week:</label>
            <select
              id="gym-weekly-target"
              value={settings.gymWeeklyTarget}
              onChange={(e) => void patchSettings({ gymWeeklyTarget: Number(e.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                <option key={n} value={n}>
                  {n}×
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="gym-reminder-time">Evening gym reminder:</label>
            <select
              id="gym-reminder-time"
              value={settings.gymReminderTime}
              disabled={!settings.notificationsEnabled}
              onChange={(e) => void patchSettings({ gymReminderTime: e.target.value })}
            >
              <option value="">Off</option>
              <option value="17:00">5:00 PM</option>
              <option value="18:00">6:00 PM</option>
              <option value="19:00">7:00 PM</option>
              <option value="20:00">8:00 PM</option>
              <option value="21:00">9:00 PM</option>
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="quest-articles">Weekly quest — articles to finish:</label>
            <select
              id="quest-articles"
              value={settings.questArticlesPerWeek}
              onChange={(e) =>
                void patchSettings({ questArticlesPerWeek: Number(e.target.value) })
              }
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'Off' : n}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="video-min-minutes">Track YouTube videos longer than:</label>
            <select
              id="video-min-minutes"
              value={settings.videoMinMinutes}
              onChange={(e) => void patchSettings({ videoMinMinutes: Number(e.target.value) })}
            >
              {[1, 5, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n} min
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="quest-videos">Weekly quest — videos to finish:</label>
            <select
              id="quest-videos"
              value={settings.questVideosPerWeek}
              onChange={(e) =>
                void patchSettings({ questVideosPerWeek: Number(e.target.value) })
              }
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'Off' : n}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="quest-sprints">Weekly quest — sprints to complete:</label>
            <select
              id="quest-sprints"
              value={settings.questSprintsPerWeek}
              onChange={(e) =>
                void patchSettings({ questSprintsPerWeek: Number(e.target.value) })
              }
            >
              {[0, 1, 2, 3, 5, 7, 10].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'Off' : n}
                </option>
              ))}
            </select>
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
          <p className="hint" style={{ marginTop: 18 }}>
            ⏱ Time pill — show a floating "time on this site today" badge on these sites:
          </p>
          <form
            className="add-feed-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addPillHost();
            }}
          >
            <input
              type="text"
              value={pillInput}
              onChange={(e) => setPillInput(e.target.value)}
              placeholder="Add a domain to time (e.g. youtube.com)"
            />
            <button type="submit">Add</button>
          </form>
          {pillFeedback && <p className="feedback error">{pillFeedback}</p>}
          <div className="feeds-list" style={{ marginTop: 10 }}>
            {settings.timePillHosts.map((domain) => (
              <div className="feed-entry" key={domain}>
                <span className="feed-entry-url">{domain}</span>
                <button
                  className="remove-feed-btn"
                  title="Remove time pill from this site"
                  onClick={() => void removePillHost(domain)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="setting-row">
            <label htmlFor="focus-music">
              🎵 Open Flowtunes focus music when a session starts
            </label>
            <input
              id="focus-music"
              type="checkbox"
              checked={settings.focusMusicEnabled}
              onChange={(e) => void patchSettings({ focusMusicEnabled: e.target.checked })}
            />
          </div>
          <div className="setting-row">
            <label htmlFor="focus-minutes">Pomodoro focus length:</label>
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
          <div className="setting-row">
            <label htmlFor="focus-break-minutes">Pomodoro break length:</label>
            <select
              id="focus-break-minutes"
              value={settings.focusBreakMinutes}
              onChange={(e) => void patchSettings({ focusBreakMinutes: Number(e.target.value) })}
            >
              {[5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  {n} min
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="quest-focus">Weekly quest — focus blocks:</label>
            <select
              id="quest-focus"
              value={settings.questFocusPerWeek}
              onChange={(e) => void patchSettings({ questFocusPerWeek: Number(e.target.value) })}
            >
              {[0, 3, 5, 7, 10].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'Off' : n}
                </option>
              ))}
            </select>
          </div>
        </section>

        <AssistantSection />

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

import { useEffect, useState } from 'react';
import { HYPERFOCUS_MINUTES, SAMPLE_FEEDS } from '../../shared/constants';
import { normalizeBlockDomain } from '../../shared/focusRules';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { sendMessage } from '../../shared/messages';
import { DEFAULT_SETTINGS, getLocal, patchSettings, setLocal } from '../../shared/storage';
import type { Settings, SkinSetting, ThemeSetting } from '../../shared/types';
import { AccountSection } from './AccountSection';
import { AssistantSection } from './AssistantSection';
import { CalendarSection } from './CalendarSection';
import { GmailSection } from './GmailSection';
import { PapersSection } from './PapersSection';
import { PrivacySection } from './PrivacySection';

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
    // Re-read rather than write back the list this render captured: validation
    // above is a network round-trip, and cloud sync applies remote feeds
    // straight to this key (background/sync.ts), so the snapshot can be stale
    // by now.
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
          <div className="setting-row">
            <label htmlFor="skin-select">Accent</label>
            <select
              id="skin-select"
              value={settings.skin}
              onChange={(e) => void patchSettings({ skin: e.target.value as SkinSetting })}
            >
              <option value="auto">Match this browser</option>
              <option value="chrome">Chrome blue</option>
              <option value="brave">Brave orange</option>
              <option value="default">Reader sky</option>
            </select>
          </div>
          <p className="hint">
            Colour only — text stays Atkinson Hyperlegible at the same size on every setting.
          </p>
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
          <div className="setting-row">
            <label htmlFor="monitor-enabled">
              Jarvis check-ins{' '}
              <span className="hint-inline">(streak at risk, cards piling up, event starting soon)</span>
            </label>
            <input
              id="monitor-enabled"
              type="checkbox"
              checked={settings.assistantMonitorEnabled}
              disabled={!settings.notificationsEnabled}
              onChange={(e) => void patchSettings({ assistantMonitorEnabled: e.target.checked })}
            />
          </div>
          <div className="setting-row">
            <label htmlFor="monitor-evening-time">Evening check-in at:</label>
            <select
              id="monitor-evening-time"
              value={settings.monitorEveningTime}
              disabled={!settings.notificationsEnabled || !settings.assistantMonitorEnabled}
              onChange={(e) => void patchSettings({ monitorEveningTime: e.target.value })}
            >
              <option value="">Off</option>
              <option value="17:00">5:00 PM</option>
              <option value="18:00">6:00 PM</option>
              <option value="19:00">7:00 PM</option>
              <option value="20:00">8:00 PM</option>
              <option value="21:00">9:00 PM</option>
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
            Time pill — show a floating "time on this site today" badge on these sites:
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
        </section>

        <AssistantSection />

        <CalendarSection />

        <GmailSection />

        <AccountSection />

        <PapersSection />


        <PrivacySection />

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

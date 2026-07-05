import { useState } from 'react';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import {
  LINKS_TAGS_PROP,
  LINKS_URL_PROP,
  READING_DATE_PROP,
  READING_TYPE_PROP,
  READING_URL_PROP,
  type NotionDbSummary,
} from '../../shared/notion';
import { DEFAULT_SETTINGS, patchSettings } from '../../shared/storage';
import type { Settings } from '../../shared/types';

type Feedback = { text: string; kind: 'success' | 'error' | 'loading' } | null;

interface IntegrationRow {
  label: string;
  toggleKey: 'notionPushLinks' | 'notionPushBrainDumps' | 'notionPushTasks' | 'notionPushReading';
  dbKey: 'notionLinksDbId' | 'notionBrainDumpDbId' | 'notionTasksDbId' | 'notionReadingLogDbId';
  /** Returns a warning when the picked DB is missing expected properties */
  warn: (db: NotionDbSummary) => string | null;
}

const ROWS: IntegrationRow[] = [
  {
    label: '🔗 Links → Notion',
    toggleKey: 'notionPushLinks',
    dbKey: 'notionLinksDbId',
    warn: (db) =>
      db.props.urlProp
        ? null
        : 'Database has no url-type property — links will be saved title-only.',
  },
  {
    label: '🧠 Brain dumps → Notion',
    toggleKey: 'notionPushBrainDumps',
    dbKey: 'notionBrainDumpDbId',
    warn: () => null, // title-only pages work with any database
  },
  {
    label: '📝 Tasks → Notion',
    toggleKey: 'notionPushTasks',
    dbKey: 'notionTasksDbId',
    warn: (db) =>
      db.props.checkboxProp
        ? null
        : 'No checkbox property found — tasks will be created but completions won’t sync.',
  },
  {
    label: '📖 Reading log → Notion',
    toggleKey: 'notionPushReading',
    dbKey: 'notionReadingLogDbId',
    warn: (db) => {
      const missing = [
        !db.props.urlProp && 'a url property',
        !db.props.typeProp && 'a select property (for Article/Video)',
        !db.props.dateProp && 'a date property (for finish date)',
      ].filter(Boolean);
      return missing.length > 0
        ? `Database is missing ${missing.join(', ')} — those fields will be skipped.`
        : null;
    },
  },
];

export function NotionSection() {
  const [storedSettings] = useStorageValue('settings');
  const settings: Settings = { ...DEFAULT_SETTINGS, ...storedSettings };
  const [status] = useStorageValue('notionStatus');
  const [queue] = useStorageValue('notionQueue');

  const [tokenInput, setTokenInput] = useState('');
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [databases, setDatabases] = useState<NotionDbSummary[] | null>(null);

  const flash = (text: string, kind: 'success' | 'error') => {
    setFeedback({ text, kind });
    setTimeout(() => setFeedback(null), 4000);
  };

  const saveToken = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    await patchSettings({ notionToken: token });
    setTokenInput('');
    flash('Token saved.', 'success');
  };

  const testConnection = async () => {
    setFeedback({ text: 'Testing connection…', kind: 'loading' });
    const res = await sendMessage({ type: 'NOTION_TEST' });
    if (res.ok) flash(`Connected to "${res.name}".`, 'success');
    else flash(res.error ?? 'Connection failed.', 'error');
  };

  const loadDatabases = async () => {
    setFeedback({ text: 'Loading databases…', kind: 'loading' });
    const res = await sendMessage({ type: 'NOTION_LIST_DBS' });
    if (res.ok) {
      setDatabases(res.databases);
      setFeedback(null);
      if (res.databases.length === 0) {
        flash('No databases visible — share them with the integration in Notion first.', 'error');
      }
    } else {
      flash(res.error ?? 'Could not list databases.', 'error');
    }
  };

  const pickDb = async (row: IntegrationRow, dbId: string) => {
    const patch: Partial<Settings> = { [row.dbKey]: dbId };
    const picked = databases?.find((d) => d.id === dbId);
    if (row.dbKey === 'notionTasksDbId') {
      patch.notionTasksDoneProp = picked?.props.checkboxProp ?? '';
    }
    // Fall back to conventional names when detection finds nothing — a push
    // that 400s with a clear error beats silently dropping the field
    if (row.dbKey === 'notionLinksDbId' && picked) {
      patch.notionLinksUrlProp = picked.props.urlProp || LINKS_URL_PROP;
      patch.notionLinksTagsProp = picked.props.tagsProp || LINKS_TAGS_PROP;
    }
    if (row.dbKey === 'notionReadingLogDbId' && picked) {
      patch.notionReadingUrlProp = picked.props.urlProp || READING_URL_PROP;
      patch.notionReadingTypeProp = picked.props.typeProp || READING_TYPE_PROP;
      patch.notionReadingDateProp = picked.props.dateProp || READING_DATE_PROP;
    }
    await patchSettings(patch);
  };

  const hasToken = settings.notionToken !== '';

  return (
    <section className="section">
      <h2>Notion Sync</h2>
      <p className="hint">
        Pushes links, brain dumps, tasks, and finished reads into your Notion workspace. Create an
        internal integration at notion.so/my-integrations, paste its token here, and share each
        target database with the integration (··· menu → Connections).
      </p>

      <form
        className="add-feed-form"
        onSubmit={(e) => {
          e.preventDefault();
          void saveToken();
        }}
      >
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder={hasToken ? 'Token saved — paste to replace' : 'Paste your ntn_… token'}
        />
        <button type="submit">Save token</button>
      </form>

      <div className="button-group" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="secondary-btn"
          disabled={!hasToken}
          onClick={() => void testConnection()}
        >
          Test connection
        </button>
        <button
          type="button"
          className="secondary-btn"
          disabled={!hasToken}
          onClick={() => void loadDatabases()}
        >
          Load databases
        </button>
      </div>
      {feedback && <p className={`feedback ${feedback.kind}`}>{feedback.text}</p>}

      {ROWS.map((row) => {
        const dbId = settings[row.dbKey];
        const picked = databases?.find((d) => d.id === dbId);
        const warning = picked ? row.warn(picked) : null;
        return (
          <div key={row.dbKey}>
            <div className="setting-row">
              <label htmlFor={row.dbKey}>
                <input
                  type="checkbox"
                  checked={settings[row.toggleKey]}
                  disabled={!hasToken || dbId === ''}
                  onChange={(e) => void patchSettings({ [row.toggleKey]: e.target.checked })}
                  style={{ marginRight: 8 }}
                />
                {row.label}
              </label>
              <select
                id={row.dbKey}
                value={dbId}
                disabled={!hasToken}
                onChange={(e) => void pickDb(row, e.target.value)}
              >
                <option value="">— pick a database —</option>
                {/* Keep the saved choice visible before "Load databases" runs */}
                {dbId !== '' && !picked && <option value={dbId}>Saved database</option>}
                {databases?.map((db) => (
                  <option key={db.id} value={db.id}>
                    {db.title}
                  </option>
                ))}
              </select>
            </div>
            {warning && <p className="feedback error">{warning}</p>}
          </div>
        );
      })}

      {status.authError && (
        <p className="feedback error">
          Notion token rejected — pushes are paused. Paste a new token to resume.
          {status.lastError ? ` (${status.lastError})` : ''}
        </p>
      )}
      {hasToken && (
        <p className="hint">
          {status.lastSuccessAt > 0
            ? `Last push: ${new Date(status.lastSuccessAt).toLocaleString()}`
            : 'No pushes yet'}
          {` · ${queue.length} queued`}
          {!status.authError && status.lastError ? ` · Last error: ${status.lastError}` : ''}
          {queue.length > 0 && !status.authError && (
            <>
              {' · '}
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void sendMessage({ type: 'NOTION_FLUSH_NOW' })}
              >
                Retry now
              </button>
            </>
          )}
        </p>
      )}
    </section>
  );
}

import { useState } from 'react';
import { JOBS_PAGE_PATH } from '../../shared/constants';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { parseBoardToken, parseWorkdayUrl } from '../../shared/jobs/adapters';
import { sendMessage } from '../../shared/messages';
import type { JobProfile, JobSource } from '../../shared/types';

/**
 * Job search setup: where to look, and what to measure a posting against.
 *
 * The profile fields are the scorer's whole input — skills and roles feed the
 * points, the rest feed the hard filters — so this form is the one place that
 * decides what the board considers a good job.
 */

const ADAPTERS: { id: JobSource['adapter']; label: string; hint: string }[] = [
  { id: 'ycombinator', label: 'Y Combinator', hint: 'Leave the token blank for engineering + science' },
  { id: 'greenhouse', label: 'Greenhouse', hint: 'job-boards.greenhouse.io/… or a token' },
  { id: 'lever', label: 'Lever', hint: 'jobs.lever.co/… or a token' },
  { id: 'ashby', label: 'Ashby', hint: 'jobs.ashbyhq.com/… or a token' },
  { id: 'workday', label: 'Workday', hint: '….myworkdayjobs.com/…' },
  { id: 'simplify', label: 'SimplifyJobs lists', hint: 'Blank for both, or new-grad / internship' },
  { id: 'rss', label: 'RSS feed', hint: 'A feed URL — university and lab boards' },
];

/** The four comma-separated list fields, which all behave identically. */
const LISTS: {
  key: 'skills' | 'roleFamilies' | 'locations' | 'watchlist';
  label: string;
  hint: string;
  placeholder: string;
}[] = [
  {
    key: 'skills',
    label: 'Skills',
    hint: '(earns points when a posting mentions one)',
    placeholder: 'python, pytorch, distributed systems',
  },
  {
    key: 'roleFamilies',
    label: 'Target roles',
    hint: '(matched against the job title)',
    placeholder: 'machine learning, research scientist',
  },
  {
    key: 'locations',
    label: 'Locations',
    hint: '(blank accepts anywhere; remote always passes)',
    placeholder: 'San Francisco, New York',
  },
  {
    key: 'watchlist',
    label: 'Companies to watch',
    hint: '(worth extra points)',
    placeholder: 'anthropic, nvidia',
  },
];

/** Comma-separated text ⇄ the string lists the profile stores. */
const toList = (text: string): string[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

export function JobsSection() {
  const [sources] = useStorageValue('jobSources');
  const [profile, profileLoaded] = useStorageValue('jobProfile');

  const [adapter, setAdapter] = useState<JobSource['adapter']>('ycombinator');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  const addSource = async () => {
    setError('');
    const base: JobSource = {
      id: crypto.randomUUID(),
      adapter,
      label: label.trim(),
      enabled: true,
      token: token.trim(),
    };

    let source = base;
    if (adapter === 'rss') {
      source = { ...base, url: token.trim(), label: base.label || token.trim() };
    }
    if (adapter === 'greenhouse' || adapter === 'lever' || adapter === 'ashby') {
      const parsed = parseBoardToken(adapter, token);
      if (!parsed) {
        setError(`That is not a ${adapter} board link. Paste the URL of the company's job board.`);
        return;
      }
      source = { ...base, token: parsed, label: base.label || parsed };
    }
    if (adapter === 'workday') {
      const parsed = parseWorkdayUrl(token);
      if (!parsed) {
        setError('That does not look like a Workday careers URL.');
        return;
      }
      source = {
        ...base,
        ...parsed,
        label: base.label || parsed.tenant,
        // The list endpoint's server-side filter; narrowing here is what keeps
        // a 900-posting tenant from becoming 900 requests.
        token: 'intern',
      };
    }

    const result = await sendMessage({ type: 'JOB_SOURCE_SAVE', source });
    if (!result.ok) {
      setError(result.error ?? 'Could not save that source.');
      return;
    }
    setLabel('');
    setToken('');
  };

  const saveProfile = (patch: Partial<JobProfile>) =>
    sendMessage({ type: 'JOB_PROFILE_SAVE', patch });

  return (
    <section className="section">
      <h2>Jobs</h2>
      <p className="hint">
        Collects new-grad, internship and research postings from job boards that publish them, then
        ranks each one against the profile below. Runs once a day.{' '}
        <a href={chrome.runtime.getURL(JOBS_PAGE_PATH)} target="_blank" rel="noreferrer">
          Open the board
        </a>
        .
      </p>

      <h3>Sources</h3>
      <form
        className="add-feed-form"
        onSubmit={(event) => {
          event.preventDefault();
          void addSource();
        }}
      >
        <select
          value={adapter}
          onChange={(event) => setAdapter(event.target.value as JobSource['adapter'])}
          aria-label="Source type"
        >
          {ADAPTERS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Company name (optional)"
          aria-label="Company name"
        />
        <input
          type="text"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={ADAPTERS.find((option) => option.id === adapter)?.hint}
          aria-label="Board token or URL"
        />
        <button type="submit">Add</button>
      </form>
      {error && <p className="feedback error">{error}</p>}

      {sources.length === 0 ? (
        <p className="hint">No sources yet.</p>
      ) : (
        sources.map((source) => (
          <div className="feed-entry" key={source.id}>
            <span className="feed-entry-url">
              {source.label || source.token} · {source.adapter}
            </span>
            <button
              type="button"
              className="remove-feed-btn"
              onClick={() => void sendMessage({ type: 'JOB_SOURCE_DELETE', id: source.id })}
            >
              Remove
            </button>
          </div>
        ))
      )}

      <h3>Your profile</h3>
      <p className="hint">
        Skills and target roles earn a posting points. The rest are hard filters — a posting that
        fails one is greyed rather than hidden, because they are read out of prose and can be wrong.
      </p>

      {/* These inputs are uncontrolled (edit freely, commit on blur), and
          defaultValue is only read on mount — rendering them before storage
          resolves would leave every field blank for good. */}
      {!profileLoaded ? (
        <p className="hint">Loading…</p>
      ) : (
        <>
          {LISTS.map((field) => (
          <div className="setting-row" key={field.key}>
            <label htmlFor={`job-${field.key}`}>
              {field.label}
              <span className="hint-inline">{field.hint}</span>
            </label>
            <input
              id={`job-${field.key}`}
              type="text"
              defaultValue={profile[field.key].join(', ')}
              placeholder={field.placeholder}
              onBlur={(event) => void saveProfile({ [field.key]: toList(event.target.value) })}
            />
          </div>
        ))}

        <div className="setting-row">
          <label htmlFor="job-max-years">
            Experience ceiling
            <span className="hint-inline">(a posting asking for more is greyed out)</span>
          </label>
          <input
            id="job-max-years"
            type="number"
            min={0}
            max={20}
            defaultValue={profile.maxYearsRequired}
            onBlur={(event) => void saveProfile({ maxYearsRequired: Number(event.target.value) || 0 })}
          />
        </div>

        <div className="setting-row">
          <label htmlFor="job-sponsorship">I need visa sponsorship</label>
          <input
            id="job-sponsorship"
            type="checkbox"
            checked={profile.needsSponsorship}
            onChange={(event) => void saveProfile({ needsSponsorship: event.target.checked })}
          />
        </div>

        <div className="setting-row">
          <label htmlFor="job-citizen">I hold US citizenship</label>
          <input
            id="job-citizen"
            type="checkbox"
            checked={profile.usCitizen}
            onChange={(event) => void saveProfile({ usCitizen: event.target.checked })}
          />
        </div>
        </>
      )}

    </section>
  );
}

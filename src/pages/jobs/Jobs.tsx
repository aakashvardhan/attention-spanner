import { useState } from 'react';
import { NEWTAB_PAGE_PATH } from '../../shared/constants';
import { useJobs, type JobFilter } from '../../shared/hooks/useJobs';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { useTheme } from '../../shared/hooks/useTheme';
import { EmptyState, Stat, StatRow } from '../../shared/components/ui';
import type { JobKind } from '../../shared/types';
import { JobRow } from './components/JobRow';

const FILTERS: { id: JobFilter; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'shortlist', label: 'Shortlist' },
  { id: 'applied', label: 'Applied' },
  { id: 'all', label: 'All' },
];

const KINDS: { id: JobKind | 'any'; label: string }[] = [
  { id: 'any', label: 'Any' },
  { id: 'new-grad', label: 'New grad' },
  { id: 'internship', label: 'Internship' },
  { id: 'research', label: 'Research' },
];

/** "3 sources · 41 new · stopped early (deadline)" — the run, in one line. */
function runSummary(run: NonNullable<ReturnType<typeof useJobs>['lastRun']>): string {
  const added = run.sources.reduce((sum, source) => sum + source.added, 0);
  const failed = run.sources.filter((source) => source.error).length;
  const parts = [
    `${run.sources.length} source${run.sources.length === 1 ? '' : 's'}`,
    `${added} new`,
    `${run.requests} request${run.requests === 1 ? '' : 's'}`,
  ];
  if (failed > 0) parts.push(`${failed} failed`);
  // A tripped ceiling is worth saying out loud: the run committed what it had,
  // and the rest is simply not fetched yet.
  if (run.stopReason !== 'done') parts.push(`stopped early (${run.stopReason})`);
  return parts.join(' · ');
}

export function Jobs() {
  const theme = useTheme();
  const jobs = useJobs();
  const [sources] = useStorageValue('jobSources');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState('');

  const shortlisted = jobs.jobs.filter((job) => job.status === 'shortlist').length;
  const applied = jobs.jobs.filter((job) => job.status === 'applied').length;

  return (
    <div className="fc-page">
      <header className="fc-header">
        <div className="fc-header-left">
          <button
            className="ghost-btn fc-back"
            onClick={() => {
              location.href = chrome.runtime.getURL(NEWTAB_PAGE_PATH);
            }}
          >
            ← Dashboard
          </button>
          <h1>Jobs</h1>
        </div>
        <button
          className="ghost-btn fc-theme-toggle"
          title={theme.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => theme.setMode(theme.resolved === 'dark' ? 'light' : 'dark')}
        >
          {theme.resolved === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      <StatRow>
        <Stat value={jobs.jobs.length} label="Tracked" />
        <Stat value={shortlisted} label="Shortlist" />
        <Stat value={applied} label="Applied" />
      </StatRow>

      <div className="job-toolbar">
        <div className="job-chips" role="group" aria-label="Status filter">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              className={jobs.filter === option.id ? 'job-chip job-chip--on' : 'job-chip'}
              aria-pressed={jobs.filter === option.id}
              onClick={() => jobs.setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="job-chips" role="group" aria-label="Stage filter">
          {KINDS.map((option) => (
            <button
              key={option.id}
              className={jobs.kind === option.id ? 'job-chip job-chip--on' : 'job-chip'}
              aria-pressed={jobs.kind === option.id}
              onClick={() => jobs.setKind(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          className="ui-btn ui-btn--primary"
          disabled={jobs.refreshing || sources.length === 0}
          onClick={() => {
            setError('');
            void jobs.refresh().then((result) => {
              if (!result.ok) setError(result.error ?? 'Refresh failed.');
            });
          }}
        >
          {jobs.refreshing ? 'Checking…' : 'Check for jobs'}
        </button>
      </div>

      {error && <p className="job-error">{error}</p>}
      {jobs.lastRun && <p className="job-run">{runSummary(jobs.lastRun)}</p>}

      {sources.length === 0 ? (
        <EmptyState>
          No sources yet. Add a job board in Settings → Jobs, then check for jobs.
        </EmptyState>
      ) : jobs.visible.length === 0 ? (
        <EmptyState>
          {jobs.loaded ? 'Nothing matches this filter yet.' : 'Loading…'}
        </EmptyState>
      ) : (
        <ul className="job-list">
          {jobs.visible.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              expanded={expanded === job.id}
              onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
              onStatus={(status) => void jobs.setStatus(job.id, status)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

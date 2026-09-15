import { useCallback, useMemo, useState } from 'react';
import { sendMessage } from '../messages';
import type { JobKind, JobStatus } from '../types';
import { compareJobs } from '../jobs/score';
import { useStorageValue } from './useStorageValue';

/**
 * The board's read/write pair, following useTasks: storage for reads (the
 * service worker is the only writer, so every surface re-renders together),
 * a message for each mutation.
 */

export type JobFilter = 'open' | 'all' | 'shortlist' | 'applied';

export function useJobs() {
  const [jobs, loaded] = useStorageValue('jobs');
  const [runs] = useStorageValue('jobRuns');
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<JobFilter>('open');
  const [kind, setKind] = useState<JobKind | 'any'>('any');

  const visible = useMemo(() => {
    return jobs
      .filter((job) => {
        if (filter === 'shortlist') return job.status === 'shortlist';
        if (filter === 'applied') return job.status === 'applied';
        // "Open" hides what you've explicitly ruled out, and nothing else —
        // a blocked job still shows, greyed, because the blocker is a guess.
        if (filter === 'open') return job.status !== 'dismissed' && job.status !== 'rejected';
        return true;
      })
      .filter((job) => kind === 'any' || job.kind === kind)
      .sort(compareJobs);
  }, [jobs, filter, kind]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      return await sendMessage({ type: 'JOBS_REFRESH' });
    } finally {
      setRefreshing(false);
    }
  }, []);

  const setStatus = useCallback(
    (id: string, status: JobStatus) => sendMessage({ type: 'JOB_SET_STATUS', id, status }),
    [],
  );

  return {
    jobs,
    visible,
    loaded,
    lastRun: runs.at(-1) ?? null,
    refreshing,
    refresh,
    setStatus,
    filter,
    setFilter,
    kind,
    setKind,
  };
}

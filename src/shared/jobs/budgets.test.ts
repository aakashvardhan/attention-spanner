import { describe, expect, it } from 'vitest';
import {
  beginRun,
  callSignature,
  checkJobBudgets,
  claimRequest,
  noteError,
  type JobRunBudgets,
} from './budgets';

const NOW = 1_000_000;
const BUDGETS: JobRunBudgets = { maxRequests: 3, maxErrors: 2, deadlineMs: 10_000 };

describe('checkJobBudgets', () => {
  it('reports room while there is room', () => {
    expect(checkJobBudgets(beginRun(NOW, BUDGETS), NOW, BUDGETS)).toBeNull();
  });

  it('stops on the deadline', () => {
    const run = beginRun(NOW, BUDGETS);
    expect(checkJobBudgets(run, NOW + 10_000, BUDGETS)).toBe('deadline');
  });

  it('stops on the request ceiling', () => {
    const run = beginRun(NOW, BUDGETS);
    for (let i = 0; i < 3; i++) claimRequest(run, `req-${i}`, NOW, BUDGETS);
    expect(checkJobBudgets(run, NOW, BUDGETS)).toBe('requests');
  });

  it('stops on repeated errors', () => {
    const run = beginRun(NOW, BUDGETS);
    noteError(run);
    expect(checkJobBudgets(run, NOW, BUDGETS)).toBeNull();
    noteError(run);
    expect(checkJobBudgets(run, NOW, BUDGETS)).toBe('errors');
  });
});

describe('claimRequest', () => {
  it('bounds a runaway adapter to the request ceiling', () => {
    // The Workday case: a tenant with 907 postings must not become 907 fetches.
    const run = beginRun(NOW, BUDGETS);
    let granted = 0;
    for (let i = 0; i < 500; i++) {
      if (claimRequest(run, `detail-${i}`, NOW, BUDGETS)) granted += 1;
    }
    expect(granted).toBe(3);
    expect(run.requests).toBe(3);
  });

  it('collapses a repeated fetch instead of spending budget on it', () => {
    const run = beginRun(NOW, BUDGETS);
    expect(claimRequest(run, 'detail-a', NOW, BUDGETS)).toBe(true);
    expect(claimRequest(run, 'detail-a', NOW, BUDGETS)).toBe(false);
    expect(run.requests).toBe(1);
  });

  it('refuses once the deadline has passed', () => {
    const run = beginRun(NOW, BUDGETS);
    expect(claimRequest(run, 'late', NOW + 10_000, BUDGETS)).toBe(false);
    expect(run.requests).toBe(0);
  });
});

describe('callSignature', () => {
  it('collides on reordered params, so a "varied" repeat is still a repeat', () => {
    expect(callSignature('detail', { site: 'a', tenant: 'b' })).toBe(
      callSignature('detail', { tenant: 'b', site: 'a' }),
    );
  });

  it('separates genuinely different calls', () => {
    expect(callSignature('detail', { path: '/1' })).not.toBe(callSignature('detail', { path: '/2' }));
  });
});

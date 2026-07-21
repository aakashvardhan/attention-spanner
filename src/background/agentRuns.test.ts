import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '../shared/ai/tools';
import { applyProposals } from './agentRuns';
import { withLock } from './runLock';

const store: Record<string, unknown> = {};

vi.mock('../shared/storage', () => ({
  getLocal: async (...keys: string[]) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = store[key] ?? (key === 'tombstones' ? {} : []);
    return out;
  },
}));

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'edit_task',
    description: 'Edit a task',
    params: {
      type: 'object',
      required: [],
      additionalProperties: false,
      properties: { text: { type: 'string', description: 'text' } },
    },
    confirm: true,
    summary: (p) => `Edit to "${(p.text as string) ?? ''}"`,
    run: async (p) => `Edited to ${p.text as string}`,
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
});

describe('withLock', () => {
  it('serializes runs under the same lock name', async () => {
    const order: string[] = [];
    const slow = withLock('t', async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    });
    const fast = withLock('t', async () => {
      order.push('fast');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['slow', 'fast']);
  });

  it('keeps the chain alive after a holder throws', async () => {
    await withLock('t2', async () => {
      throw new Error('boom');
    }).catch(() => undefined);
    await expect(withLock('t2', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('applyProposals', () => {
  it('runs proposals and reports a transcript', async () => {
    const run = await applyProposals(
      [{ tool: 'edit_task', params: { text: 'a' }, summary: 'Edit to "a"' }],
      [tool()],
    );
    expect(run.ok).toBe(true);
    expect(run.outcomes).toEqual([{ status: 'done', detail: 'Edited to a' }]);
    expect(run.text).toBe('Done: Edited to a');
  });

  it('skips a proposal whose target changed since the snapshot', async () => {
    store.tasks = [{ id: 't1', text: 'old', updatedAt: 2000 }];
    const run = await applyProposals(
      [
        {
          tool: 'edit_task',
          params: { text: 'new' },
          summary: 'Edit to "new"',
          precondition: { collection: 'tasks', id: 't1', snapshotAt: 1000 },
        },
        { tool: 'edit_task', params: { text: 'other' }, summary: 'Edit to "other"' },
      ],
      [tool()],
    );
    expect(run.ok).toBe(true); // stale is a skip, not a failure
    expect(run.outcomes[0]).toEqual({ status: 'skipped', detail: 'stale — changed since planned' });
    expect(run.outcomes[1].status).toBe('done'); // later steps still run
  });

  it('skips when the target is gone or tombstoned', async () => {
    store.tasks = [];
    const gone = await applyProposals(
      [
        {
          tool: 'edit_task',
          params: {},
          summary: 'Edit',
          precondition: { collection: 'tasks', id: 't1', snapshotAt: 1000 },
        },
      ],
      [tool()],
    );
    expect(gone.outcomes[0]).toEqual({ status: 'skipped', detail: 'stale — item no longer exists' });

    store.tasks = [{ id: 't1', text: 'x', updatedAt: 500 }];
    store.tombstones = { 'tasks:t1': 999 };
    const tombstoned = await applyProposals(
      [
        {
          tool: 'edit_task',
          params: {},
          summary: 'Edit',
          precondition: { collection: 'tasks', id: 't1', snapshotAt: 1000 },
        },
      ],
      [tool()],
    );
    expect(tombstoned.outcomes[0]).toEqual({ status: 'skipped', detail: 'stale — item was deleted' });
  });

  it('stops at the first failure and skips the rest', async () => {
    const bomb = tool({
      name: 'bomb',
      summary: () => 'Bomb',
      run: async () => {
        throw new Error('boom');
      },
    });
    const run = await applyProposals(
      [
        { tool: 'bomb', params: {}, summary: 'Bomb' },
        { tool: 'edit_task', params: { text: 'x' }, summary: 'Edit to "x"' },
      ],
      [bomb, tool()],
    );
    expect(run.ok).toBe(false);
    expect(run.outcomes.map((o) => o.status)).toEqual(['failed', 'skipped']);
  });
});

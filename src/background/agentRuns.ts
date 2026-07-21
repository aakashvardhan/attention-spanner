import { executeTool, type PlanStepOutcome } from '../shared/ai/assistant';
import { getLocal, type LocalSchema } from '../shared/storage';
import { RECORD_COLLECTIONS, type RecordCollection } from '../shared/sync/collections';
import type { AgentProposal } from '../shared/types';
import { withLock } from './runLock';

/**
 * Single apply point for agent-proposed mutations: snapshot → propose →
 * atomic apply. Proposals run serialized under one lock (two agent runs
 * can't interleave), and each precondition is re-checked against live
 * storage at apply time — a record edited or deleted since the proposer's
 * snapshot skips as stale instead of clobbering the user's change.
 * Reuses the sync layer's updatedAt/tombstone conventions.
 */

type StoredRecord = { id: string; updatedAt?: number; deletedAt?: number | null };

async function checkPrecondition(
  pre: NonNullable<AgentProposal['precondition']>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(RECORD_COLLECTIONS as readonly string[]).includes(pre.collection)) {
    return { ok: true }; // unknown collection — nothing to check against
  }
  const collection = pre.collection as RecordCollection & keyof LocalSchema;
  const [data, { tombstones }] = await Promise.all([
    getLocal(collection),
    getLocal('tombstones'),
  ]);
  if (tombstones[`${pre.collection}:${pre.id}`]) {
    return { ok: false, reason: 'stale — item was deleted' };
  }
  const list = data[collection] as unknown as StoredRecord[];
  const record = list.find((r) => r.id === pre.id);
  if (!record || record.deletedAt) {
    return { ok: false, reason: 'stale — item no longer exists' };
  }
  if ((record.updatedAt ?? 0) > pre.snapshotAt) {
    return { ok: false, reason: 'stale — changed since planned' };
  }
  return { ok: true };
}

export async function applyProposals(
  proposals: AgentProposal[],
  tools?: Parameters<typeof executeTool>[2],
): Promise<{ ok: boolean; outcomes: PlanStepOutcome[]; text: string }> {
  return withLock('agent-apply', async () => {
    const outcomes: PlanStepOutcome[] = [];
    const lines: string[] = [];
    let failed = false;

    for (const proposal of proposals) {
      if (failed) {
        outcomes.push({ status: 'skipped', detail: '' });
        lines.push(`Skipped: ${proposal.summary}`);
        continue;
      }
      if (proposal.precondition) {
        const check = await checkPrecondition(proposal.precondition);
        if (!check.ok) {
          // Stale ≠ failure: later steps still run
          outcomes.push({ status: 'skipped', detail: check.reason });
          lines.push(`Skipped (${check.reason}): ${proposal.summary}`);
          continue;
        }
      }
      try {
        const result = await executeTool(proposal.tool, proposal.params, tools);
        outcomes.push({ status: 'done', detail: result });
        lines.push(`Done: ${result}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'That step failed.';
        outcomes.push({ status: 'failed', detail: message });
        lines.push(`Failed: ${message}`);
        failed = true;
      }
    }
    return { ok: !failed, outcomes, text: lines.join('\n') };
  });
}

/**
 * Named promise-chain mutexes. The service worker is the single apply point
 * for agent-proposed mutations; withLock serializes runs so two agents (a
 * confirmed plan and a scheduled automation, say) never interleave their
 * read-modify-write cycles over the same chrome.storage arrays — the
 * "worktree" for a storage-backed app is a serialized snapshot-checked apply.
 */

const chains = new Map<string, Promise<unknown>>();

export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(name) ?? Promise.resolve();
  // Run after the previous holder regardless of how it settled
  const next = prev.then(fn, fn);
  chains.set(
    name,
    next.catch(() => undefined),
  );
  return next;
}

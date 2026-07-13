import { FACT_MAX_CHARS, MAX_ASSISTANT_FACTS } from '../shared/constants';
import { getLocal, setLocal } from '../shared/storage';
import type { AssistantFact } from '../shared/types';

/**
 * Assistant memory — lasting facts the user asked Jarvis to remember. All
 * writes happen here in the service worker so the popup and newtab never race
 * each other (same rule as tasks.ts).
 */

const normalize = (text: string) => text.trim().replace(/\s+/g, ' ');

/**
 * Pure core: add or refresh a fact. A case-insensitive duplicate bumps the
 * existing fact's updatedAt instead of duplicating; past the cap the oldest
 * facts (by updatedAt) are evicted.
 */
export function upsertFact(
  facts: AssistantFact[],
  text: string,
  now: number,
): { facts: AssistantFact[]; fact: AssistantFact } | null {
  const clean = normalize(text).slice(0, FACT_MAX_CHARS);
  if (!clean) return null;

  const existing = facts.find((f) => f.text.toLowerCase() === clean.toLowerCase());
  if (existing) {
    const fact = { ...existing, updatedAt: now };
    return { facts: facts.map((f) => (f.id === fact.id ? fact : f)), fact };
  }

  const fact: AssistantFact = { id: crypto.randomUUID(), text: clean, createdAt: now, updatedAt: now };
  const kept = [...facts, fact]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ASSISTANT_FACTS);
  return { facts: kept, fact };
}

export async function addFact(
  text: string,
): Promise<{ ok: boolean; fact?: AssistantFact; error?: string }> {
  const { assistantMemory } = await getLocal('assistantMemory');
  const result = upsertFact(assistantMemory, text, Date.now());
  if (!result) return { ok: false, error: 'Nothing to remember.' };
  await setLocal({ assistantMemory: result.facts });
  return { ok: true, fact: result.fact };
}

export async function deleteFact(id: string): Promise<void> {
  const { assistantMemory } = await getLocal('assistantMemory');
  await setLocal({ assistantMemory: assistantMemory.filter((f) => f.id !== id) });
}

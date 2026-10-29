import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addProvocation, updateProvocation } from './provocations';
import { MAX_PROVOCATIONS } from '../shared/constants';
import type { Provocation, ProvocationDraft } from '../shared/types';

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (items: Record<string, unknown>) => void Object.assign(store, items),
      },
    },
  });
});

const draft = (over: Partial<ProvocationDraft> = {}): ProvocationDraft => ({
  docKey: 'doc1',
  paperId: null,
  page: 3,
  kind: 'page',
  question: 'Why?',
  answer: '',
  status: 'open',
  annotationId: null,
  ...over,
});

describe('provocations writes', () => {
  it('stores a record with null paperId', async () => {
    const r = await addProvocation(draft());
    expect(r.ok).toBe(true);
    expect((store.provocations as Provocation[])[0].paperId).toBeNull();
  });

  it('open→answered adds 10 once', async () => {
    const r = await addProvocation(draft());
    if (!r.ok) throw new Error('add failed');
    const id = r.provocation.id;
    const a = await updateProvocation(id, { answer: 'because', status: 'answered' });
    expect(a).toEqual({ ok: true, xp: 10 });
    await updateProvocation(id, { answer: 'edited' });
    const b = await updateProvocation(id, { status: 'answered' });
    expect(b).toEqual({ ok: true, xp: 10 });
    expect((store.provocations as Provocation[])[0].xp).toBe(10);
  });

  it('refuses past the cap', async () => {
    store.provocations = Array.from({ length: MAX_PROVOCATIONS }, (_, i) => ({ id: String(i) }));
    const r = await addProvocation(draft());
    expect(r.ok).toBe(false);
  });
});

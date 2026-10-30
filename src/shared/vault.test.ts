import { beforeAll, describe, expect, it } from 'vitest';
import type { DumpEntry, Vault } from './types';
import {
  PBKDF2_ITERATIONS,
  VaultLockedError,
  createVault,
  normalizeRecoveryCode,
  openAll,
  openEntry,
  planSetup,
  sealEntry,
  sealPending,
  unlockVault,
} from './vault';

/*
 * The vault seals with the public key alone, so a dump never asks for the
 * passphrase; reading back needs the passphrase or the recovery code. One
 * vault for the file: key derivation is deliberately slow.
 */
let vault: Vault;
let recoveryCode: string;
const entry: DumpEntry = { text: 'nowhere near in career', bullets: ['Career feels slow.'], createdAt: 7 };

beforeAll(async () => {
  ({ vault, recoveryCode } = await createVault('correct horse'));
}, 30_000);

describe('vault', () => {
  it('round-trips an entry', async () => {
    const locked = await sealEntry(vault.publicKey, entry);
    const key = await unlockVault(vault, 'correct horse', 'passphrase');
    expect(await openEntry(key, locked)).toEqual(entry);
  });

  it('round-trips 4000 chars of mixed text', async () => {
    const text = 'é "quote"\n🙂'.repeat(400).slice(0, 4000);
    const big = { text, bullets: ['a', 'b'], createdAt: 1 };
    const key = await unlockVault(vault, 'correct horse', 'passphrase');
    expect(await openEntry(key, await sealEntry(vault.publicKey, big))).toEqual(big);
  });

  it('unlocks with the recovery code in any casing or spacing', async () => {
    const locked = await sealEntry(vault.publicKey, entry);
    const typed = recoveryCode.toLowerCase().replace(/-/g, ' ');
    const key = await unlockVault(vault, typed, 'recovery');
    expect(await openEntry(key, locked)).toEqual(entry);
  });

  it('reads lookalike digits in a recovery code as the letters base32 uses', () => {
    expect(normalizeRecoveryCode('o0-i1 b8')).toBe('OOIIBB');
  });

  it('rejects a wrong passphrase or recovery code', async () => {
    await expect(unlockVault(vault, 'nope', 'passphrase')).rejects.toBeInstanceOf(VaultLockedError);
    await expect(unlockVault(vault, 'AAAA-AAAA', 'recovery')).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('seals pending dumps with their dates, newest first', async () => {
    const sealed = await sealPending(vault.publicKey, [{ id: 'old', text: 'x', createdAt: 1 }], {
      text: 'y',
      bullets: ['b'],
      createdAt: 5,
    });
    expect(sealed.map((s) => s.createdAt)).toEqual([5, 1]);
    expect(sealed[1].id).toBe('old');
    const key = await unlockVault(vault, 'correct horse', 'passphrase');
    expect(await openEntry(key, sealed[1])).toEqual({ text: 'x', bullets: [], createdAt: 1 });
  });

  it('stores no plaintext', async () => {
    const locked = await sealEntry(vault.publicKey, entry);
    expect(JSON.stringify(locked)).not.toContain('career');
    expect(JSON.stringify(vault)).not.toContain('correct horse');
  });

  it('uses enough PBKDF2 iterations', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });

  it('opens what it can when one entry is damaged', async () => {
    const good = await sealEntry(vault.publicKey, entry, 'good');
    const bad = { ...(await sealEntry(vault.publicKey, entry, 'bad')), data: 'AAAA' };
    const key = await unlockVault(vault, 'correct horse', 'passphrase');
    const { opened, failed } = await openAll(key, [good, bad]);
    expect(opened.map((e) => e.id)).toEqual(['good']);
    expect(failed).toBe(1);
  });
});

/** Two tabs can each reach first-time setup; the second must never replace the first vault. */
describe('planSetup', () => {
  const current = { id: 'cur', text: 'now', bullets: ['lighter'], createdAt: 9 };

  it('makes the fresh vault when none exists and seals the parked copy under its id', async () => {
    const plan = await planSetup(
      {
        vault: null,
        dumps: [
          { id: 'cur', text: 'now', createdAt: 9 },
          { id: 'old', text: 'x', createdAt: 1 },
        ],
        lockedDumps: [],
      },
      vault,
      current,
    );
    expect(plan.vault).toBe(vault);
    expect(plan.dumps).toEqual([]);
    expect(plan.lockedDumps.map((d) => d.id)).toEqual(['cur', 'old']);
    const key = await unlockVault(vault, 'correct horse', 'passphrase');
    expect((await openEntry(key, plan.lockedDumps[0])).bullets).toEqual(['lighter']);
  });

  it('keeps an existing vault and replaces the raw copy another tab sealed', async () => {
    const other = await createVault('other tab');
    const sealedByOther = await sealEntry(other.vault.publicKey, { text: 'now', bullets: [], createdAt: 9 }, 'cur');
    const plan = await planSetup({ vault: other.vault, dumps: [], lockedDumps: [sealedByOther] }, vault, current);
    expect(plan.vault).toBe(other.vault);
    expect(plan.lockedDumps).toHaveLength(1);
    const key = await unlockVault(other.vault, 'other tab', 'passphrase');
    expect((await openEntry(key, plan.lockedDumps[0])).bullets).toEqual(['lighter']);
  }, 30_000);
});

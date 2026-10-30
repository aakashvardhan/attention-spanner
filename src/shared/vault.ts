import type { Dump, DumpEntry, LockedDump, Sealed, Vault } from './types';

/*
 * Dumps are sealed with a public key, so writing one never asks for the
 * passphrase; only reading them back does. Each entry gets its own AES-GCM
 * key, wrapped with RSA-OAEP. The private key is kept twice, encrypted under
 * the passphrase and under the recovery code, each through PBKDF2.
 */

export const PBKDF2_ITERATIONS = 600_000;
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' } as const;
const subtle = () => globalThis.crypto.subtle;

/** A wrong passphrase or recovery code */
export class VaultLockedError extends Error {
  constructor() {
    super("That didn't unlock it.");
    this.name = 'VaultLockedError';
  }
}

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const LOOKALIKES: Record<string, string> = { '0': 'O', '1': 'I', '8': 'B' };

/** Uppercase, no spaces or dashes, and 0/1/8 read as O/I/B (base32 has none of them): how it's typed doesn't matter */
export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[018]/g, (c) => LOOKALIKES[c]);
}

/** 130 random bits as 26 base32 characters, grouped in fours for writing down */
function newRecoveryCode(): string {
  const chars = Array.from(random(26), (b) => BASE32[b & 31]).join('');
  return chars.match(/.{1,4}/g)!.join('-');
}

async function secretKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function sealWithSecret(bytes: ArrayBuffer, secret: string): Promise<Sealed> {
  const salt = random(16);
  const iv = random(12);
  const data = await subtle().encrypt({ name: 'AES-GCM', iv }, await secretKey(secret, salt), bytes);
  return { salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function createVault(passphrase: string): Promise<{ vault: Vault; recoveryCode: string }> {
  const pair = await subtle().generateKey(
    { ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
  );
  const pkcs8 = await subtle().exportKey('pkcs8', pair.privateKey);
  const recoveryCode = newRecoveryCode();
  const [publicKey, byPassphrase, byRecovery] = await Promise.all([
    subtle().exportKey('jwk', pair.publicKey),
    sealWithSecret(pkcs8, passphrase),
    sealWithSecret(pkcs8, normalizeRecoveryCode(recoveryCode)),
  ]);
  return { vault: { publicKey, byPassphrase, byRecovery }, recoveryCode };
}

export async function sealEntry(
  publicKey: JsonWebKey,
  entry: DumpEntry,
  id: string = crypto.randomUUID(),
): Promise<LockedDump> {
  const pub = await subtle().importKey('jwk', { ...publicKey, key_ops: ['wrapKey'] }, RSA, false, ['wrapKey']);
  const key = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = random(12);
  const data = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(entry)));
  const wrappedKey = await subtle().wrapKey('raw', key, pub, RSA);
  return { id, createdAt: entry.createdAt, wrappedKey: b64(wrappedKey), iv: b64(iv), data: b64(data) };
}

/**
 * Dumps waiting for first-time setup, plus the one that triggered it, sealed
 * newest first. `current` keeps the id it was parked under, so its sealed copy
 * replaces the parked one rather than sitting beside it.
 */
export async function sealPending(
  publicKey: JsonWebKey,
  pending: readonly Dump[],
  current?: DumpEntry & { id?: string },
): Promise<LockedDump[]> {
  const sealed = await Promise.all(
    pending.map((d) => sealEntry(publicKey, { text: d.text, bullets: [], createdAt: d.createdAt }, d.id)),
  );
  if (current) {
    const { id, ...entry } = current;
    sealed.push(await sealEntry(publicKey, entry, id));
  }
  return sealed.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The storage write that finishes setup. If another tab finished first, its
 * vault stands and `fresh` is thrown away: replacing a vault would make every
 * entry sealed under it unreadable for good.
 */
export async function planSetup(
  stored: { vault: Vault | null; dumps: readonly Dump[]; lockedDumps: readonly LockedDump[] },
  fresh: Vault,
  current: DumpEntry & { id: string },
): Promise<{ vault: Vault; lockedDumps: LockedDump[]; dumps: [] }> {
  const vault = stored.vault ?? fresh;
  const sealed = await sealPending(
    vault.publicKey,
    stored.dumps.filter((d) => d.id !== current.id),
    current,
  );
  const ids = new Set(sealed.map((d) => d.id));
  const lockedDumps = [...sealed, ...stored.lockedDumps.filter((d) => !ids.has(d.id))];
  return { vault, lockedDumps: lockedDumps.sort((a, b) => b.createdAt - a.createdAt), dumps: [] };
}

/** The private key, non-extractable, held only by whoever called this */
export async function unlockVault(vault: Vault, secret: string, via: 'passphrase' | 'recovery'): Promise<CryptoKey> {
  const sealed = via === 'passphrase' ? vault.byPassphrase : vault.byRecovery;
  const typed = via === 'passphrase' ? secret : normalizeRecoveryCode(secret);
  let pkcs8: ArrayBuffer;
  try {
    pkcs8 = await subtle().decrypt(
      { name: 'AES-GCM', iv: unb64(sealed.iv) },
      await secretKey(typed, unb64(sealed.salt!)),
      unb64(sealed.data),
    );
  } catch {
    throw new VaultLockedError();
  }
  return subtle().importKey('pkcs8', pkcs8, RSA, false, ['unwrapKey']);
}

export async function openEntry(privateKey: CryptoKey, locked: LockedDump): Promise<DumpEntry> {
  const key = await subtle().unwrapKey('raw', unb64(locked.wrappedKey), privateKey, RSA, 'AES-GCM', false, ['decrypt']);
  const bytes = await subtle().decrypt({ name: 'AES-GCM', iv: unb64(locked.iv) }, key, unb64(locked.data));
  return JSON.parse(new TextDecoder().decode(bytes)) as DumpEntry;
}

/** Every entry that opens, newest first; a damaged one is counted, never allowed to hide the rest */
export async function openAll(
  privateKey: CryptoKey,
  locked: readonly LockedDump[],
): Promise<{ opened: (DumpEntry & { id: string })[]; failed: number }> {
  const results = await Promise.allSettled(
    locked.map(async (d) => ({ ...(await openEntry(privateKey, d)), id: d.id })),
  );
  const opened = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  return { opened: opened.sort((a, b) => b.createdAt - a.createdAt), failed: results.length - opened.length };
}

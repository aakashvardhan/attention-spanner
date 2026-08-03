/**
 * Passcode lock for brain dumps — the state half. The crypto lives in
 * notesVault.ts, which encrypts the notes themselves with AES-256-GCM; this
 * module owns the shared PBKDF2 primitive and the "is it hidden right now"
 * predicate that read paths gate on.
 *
 * A locked note is not merely hidden: without the passcode there is nothing to
 * show, because storage holds only ciphertext.
 */

/** PBKDF2-SHA256 rounds for passcode → key. Shared by wrap and rewrap. */
export const PBKDF2_ITERATIONS = 120_000;
const KEY_BITS = 256;

/** Shortest passcode the options page accepts. Guards real ciphertext now, not
 *  a render gate, so it has to survive offline brute force. */
export const MIN_PASSCODE_LENGTH = 8;

export function toHex(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...view].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array((hex.match(/../g) ?? []).map((byte) => parseInt(byte, 16)));
}

/** Stretch a passcode into 256 raw bits. */
export async function pbkdf2Bits(
  passcode: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passcode),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
}

/** No vault = encryption is off, so notes are never hidden. */
export function notesLocked(hasVault: boolean, unlocked: boolean): boolean {
  return hasVault && !unlocked;
}

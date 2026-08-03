import { fromHex, pbkdf2Bits, PBKDF2_ITERATIONS, toHex } from './notesLock';

/**
 * Encryption at rest for brain dumps.
 *
 * Envelope scheme, chosen so capture is never blocked. The vault holds an ECDH
 * P-256 keypair: the public half sits in storage as plain text, so the service
 * worker can seal a new dump even while notes are locked; the private half is
 * wrapped by the passcode, so *reading* needs an unlock. ECDH is only key
 * agreement here — every byte of note text is sealed with AES-256-GCM.
 *
 * Per note: a fresh ephemeral keypair agrees a secret with the vault public
 * key, HKDF-SHA256 stretches it to a 256-bit AES key, and AES-256-GCM seals the
 * text with the note id as additional authenticated data. The ephemeral private
 * key is discarded, so the blob is unreadable without the vault private key, and
 * the AAD binding means a blob cannot be moved to another note's record.
 *
 * The passcode itself is never stored, not even hashed: unwrapping the private
 * key IS the verification, because AES-GCM authenticates.
 *
 * Not a defence against devtools on an unlocked session — the unwrapped key
 * lives in chrome.storage.session by design, which is what "unlocked" means.
 */

const IV_BYTES = 12;
const SALT_BYTES = 16;
const HKDF_INFO = 'adhd-notes-v1';
const BLOB_PREFIX = 'v1';

export interface NotesVault {
  /** ECDH P-256 public key. Plain text on purpose — it can only seal, never open. */
  pubJwk: JsonWebKey;
  /** PBKDF2 salt for passcode → wrapping key */
  saltHex: string;
  iterations: number;
  /** `ivHex:ctHex` — AES-256-GCM over the private key's PKCS8 bytes */
  wrappedPrivate: string;
}

/** The three content fields of a BrainDumpNote that get sealed. */
export interface NoteContent {
  rawText: string;
  bullets: string[];
  taskTexts: string[];
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Passcode → AES-256-GCM wrapping key for the vault's private key. */
async function wrappingKey(
  passcode: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const bits = await pbkdf2Bits(passcode, salt, iterations);
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Agreed secret → 256-bit AES-GCM key. Salted by the ephemeral public key. */
async function contentKey(secret: ArrayBuffer, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(HKDF_INFO) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * A fresh vault, plus the private key already unwrapped so the caller can stay
 * unlocked without re-entering the passcode it just chose.
 */
export async function createVault(
  passcode: string,
): Promise<{ vault: NotesVault; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveKey', 'deriveBits']);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await wrappingKey(passcode, salt, PBKDF2_ITERATIONS),
    pkcs8,
  );
  return {
    vault: {
      pubJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
      saltHex: toHex(salt),
      iterations: PBKDF2_ITERATIONS,
      wrappedPrivate: `${toHex(iv)}:${toHex(wrapped)}`,
    },
    privateKey: pair.privateKey,
  };
}

/** Throws on a wrong passcode — AES-GCM authenticates, so this is the check. */
export async function unlockVault(vault: NotesVault, passcode: string): Promise<CryptoKey> {
  return importPrivateKey(await unwrapPkcs8(vault, passcode));
}

async function unwrapPkcs8(vault: NotesVault, passcode: string): Promise<ArrayBuffer> {
  const [ivHex, ctHex] = vault.wrappedPrivate.split(':');
  if (!ivHex || !ctHex) throw new Error('Vault is corrupt.');
  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(ivHex) },
      await wrappingKey(passcode, fromHex(vault.saltHex), vault.iterations),
      fromHex(ctHex),
    );
  } catch {
    throw new Error('Wrong passcode.');
  }
}

/**
 * Change the passcode by re-wrapping the private key. Sealed notes are never
 * touched — the keypair, and so every existing blob, stays valid.
 */
export async function rewrapVault(
  vault: NotesVault,
  current: string,
  next: string,
): Promise<NotesVault> {
  const pkcs8 = await unwrapPkcs8(vault, current);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await wrappingKey(next, salt, PBKDF2_ITERATIONS),
    pkcs8,
  );
  return {
    ...vault,
    saltHex: toHex(salt),
    iterations: PBKDF2_ITERATIONS,
    wrappedPrivate: `${toHex(iv)}:${toHex(wrapped)}`,
  };
}

/*
 * The unlocked private key crosses contexts (page ↔ service worker) through
 * chrome.storage.session, which only carries structured-cloneable values — a
 * CryptoKey does not survive the trip, so it travels as PKCS8 hex.
 */

export async function exportPrivateKey(key: CryptoKey): Promise<string> {
  return toHex(await crypto.subtle.exportKey('pkcs8', key));
}

export async function importPrivateKey(pkcs8: ArrayBuffer | string): Promise<CryptoKey> {
  const bytes = typeof pkcs8 === 'string' ? fromHex(pkcs8) : new Uint8Array(pkcs8);
  return crypto.subtle.importKey('pkcs8', bytes, ECDH, true, ['deriveKey', 'deriveBits']);
}

/** Seal one string against the vault's public key. Needs no passcode. */
export async function seal(text: string, vault: NotesVault, noteId: string): Promise<string> {
  const recipient = await crypto.subtle.importKey('jwk', vault.pubJwk, ECDH, false, []);
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipient },
    ephemeral.privateKey,
    256,
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(noteId) },
    await contentKey(secret, ephPub),
    enc.encode(text),
  );
  return `${BLOB_PREFIX}:${toHex(ephPub)}:${toHex(iv)}:${toHex(ct)}`;
}

/** Reverse of `seal`. Throws if the key, the note id or the blob is wrong. */
export async function open(blob: string, privateKey: CryptoKey, noteId: string): Promise<string> {
  const [version, ephPubHex, ivHex, ctHex] = blob.split(':');
  if (version !== BLOB_PREFIX || !ephPubHex || !ivHex || !ctHex) {
    throw new Error('Unrecognised note ciphertext.');
  }
  const ephPub = fromHex(ephPubHex);
  const secret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await crypto.subtle.importKey('raw', ephPub, ECDH, false, []) },
    privateKey,
    256,
  );
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromHex(ivHex), additionalData: enc.encode(noteId) },
    await contentKey(secret, ephPub),
    fromHex(ctHex),
  );
  return dec.decode(plain);
}

/*
 * Note-shaped wrappers. Content is sealed as three independent blobs (raw text,
 * bullets, one per proposed task) so that no write path ever has to decrypt in
 * order to update: structuring writes the bullets blob without touching the raw
 * one, and confirming a task flips its addedTaskId without touching its text.
 */

export interface SealedNote {
  encRaw: string;
  encBullets: string;
  encTaskTexts: string[];
}

export async function sealNote(
  content: NoteContent,
  vault: NotesVault,
  noteId: string,
): Promise<SealedNote> {
  return {
    encRaw: await seal(content.rawText, vault, noteId),
    encBullets: await seal(JSON.stringify(content.bullets), vault, noteId),
    encTaskTexts: await Promise.all(content.taskTexts.map((t) => seal(t, vault, noteId))),
  };
}

export async function openNote(
  sealed: SealedNote,
  privateKey: CryptoKey,
  noteId: string,
): Promise<NoteContent> {
  return {
    rawText: await open(sealed.encRaw, privateKey, noteId),
    bullets: JSON.parse(await open(sealed.encBullets, privateKey, noteId)) as string[],
    taskTexts: await Promise.all(sealed.encTaskTexts.map((t) => open(t, privateKey, noteId))),
  };
}

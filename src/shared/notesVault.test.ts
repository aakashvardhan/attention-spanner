import { describe, expect, it } from 'vitest';
import {
  createVault,
  exportPrivateKey,
  importPrivateKey,
  open,
  openNote,
  rewrapVault,
  seal,
  sealNote,
  unlockVault,
} from './notesVault';

const PASS = 'correct horse';
const NOTE_ID = 'note-1';

describe('vault lifecycle', () => {
  it('unlocks with the passcode it was created from', async () => {
    const { vault } = await createVault(PASS);
    await expect(unlockVault(vault, PASS)).resolves.toBeDefined();
  });

  it('rejects a wrong passcode instead of returning a useless key', async () => {
    const { vault } = await createVault(PASS);
    await expect(unlockVault(vault, 'wrong horse')).rejects.toThrow('Wrong passcode.');
    await expect(unlockVault(vault, '')).rejects.toThrow('Wrong passcode.');
  });

  it('never stores the passcode, hashed or otherwise', async () => {
    const { vault } = await createVault(PASS);
    expect(JSON.stringify(vault)).not.toContain(PASS);
  });

  it('survives the round trip through session storage as PKCS8 hex', async () => {
    const { vault, privateKey } = await createVault(PASS);
    const blob = await seal('kept', vault, NOTE_ID);
    const revived = await importPrivateKey(await exportPrivateKey(privateKey));
    expect(await open(blob, revived, NOTE_ID)).toBe('kept');
  });
});

describe('changing the passcode', () => {
  it('rewraps the key without invalidating notes sealed beforehand', async () => {
    const { vault } = await createVault(PASS);
    const blob = await seal('written under the old passcode', vault, NOTE_ID);

    const rewrapped = await rewrapVault(vault, PASS, 'a longer passphrase');

    const key = await unlockVault(rewrapped, 'a longer passphrase');
    expect(await open(blob, key, NOTE_ID)).toBe('written under the old passcode');
    await expect(unlockVault(rewrapped, PASS)).rejects.toThrow('Wrong passcode.');
  });

  it('refuses to rewrap without the current passcode', async () => {
    const { vault } = await createVault(PASS);
    await expect(rewrapVault(vault, 'not it', 'whatever else')).rejects.toThrow('Wrong passcode.');
  });
});

describe('sealing content', () => {
  it('round-trips text through the vault', async () => {
    const { vault, privateKey } = await createVault(PASS);
    const text = 'ship the thing, call mom, stop doomscrolling';
    expect(await open(await seal(text, vault, NOTE_ID), privateKey, NOTE_ID)).toBe(text);
  });

  it('leaves no plaintext in the blob', async () => {
    const { vault } = await createVault(PASS);
    const blob = await seal('doomscrolling', vault, NOTE_ID);
    expect(blob).not.toContain('doomscrolling');
    expect(blob.startsWith('v1:')).toBe(true);
  });

  it('produces different ciphertext for the same plaintext', async () => {
    const { vault } = await createVault(PASS);
    const a = await seal('same words', vault, NOTE_ID);
    const b = await seal('same words', vault, NOTE_ID);
    expect(a).not.toBe(b);
  });

  it('cannot be opened by another vault key', async () => {
    const { vault } = await createVault(PASS);
    const other = await createVault(PASS);
    const blob = await seal('private', vault, NOTE_ID);
    await expect(open(blob, other.privateKey, NOTE_ID)).rejects.toThrow();
  });

  it('cannot be moved onto another note record', async () => {
    const { vault, privateKey } = await createVault(PASS);
    const blob = await seal('private', vault, NOTE_ID);
    await expect(open(blob, privateKey, 'note-2')).rejects.toThrow();
  });

  it('rejects a malformed blob with a clear error', async () => {
    const { privateKey } = await createVault(PASS);
    await expect(open('', privateKey, NOTE_ID)).rejects.toThrow('Unrecognised note ciphertext.');
    await expect(open('v2:a:b:c', privateKey, NOTE_ID)).rejects.toThrow(
      'Unrecognised note ciphertext.',
    );
  });
});

describe('note-shaped sealing', () => {
  it('round-trips raw text, bullets and task texts', async () => {
    const { vault, privateKey } = await createVault(PASS);
    const content = {
      rawText: 'everything on my mind',
      bullets: ['one thing', 'another thing'],
      taskTexts: ['call the dentist', 'renew the visa'],
    };

    const sealed = await sealNote(content, vault, NOTE_ID);
    expect(await openNote(sealed, privateKey, NOTE_ID)).toEqual(content);
  });

  it('handles a note with no bullets or tasks yet', async () => {
    const { vault, privateKey } = await createVault(PASS);
    const content = { rawText: 'just a dump', bullets: [], taskTexts: [] };

    const sealed = await sealNote(content, vault, NOTE_ID);
    expect(await openNote(sealed, privateKey, NOTE_ID)).toEqual(content);
  });

  it('seals the bullets independently of the raw text, so structuring never decrypts', async () => {
    const { vault, privateKey } = await createVault(PASS);
    const first = await sealNote(
      { rawText: 'the original dump', bullets: [], taskTexts: [] },
      vault,
      NOTE_ID,
    );

    // What applyStructureResult does: new bullets blob, encRaw carried through
    const restructured = {
      ...first,
      encBullets: await seal(JSON.stringify(['a bullet']), vault, NOTE_ID),
    };

    expect(await openNote(restructured, privateKey, NOTE_ID)).toEqual({
      rawText: 'the original dump',
      bullets: ['a bullet'],
      taskTexts: [],
    });
  });
});

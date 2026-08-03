import { describe, expect, it } from 'vitest';
import { fromHex, notesLocked, pbkdf2Bits, toHex } from './notesLock';

describe('hex helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 255]);
    expect(toHex(bytes)).toBe('00010f10ff');
    expect(fromHex('00010f10ff')).toEqual(bytes);
  });
});

describe('pbkdf2Bits', () => {
  const salt = new Uint8Array(16).fill(7);

  it('is deterministic for the same passcode, salt and rounds', async () => {
    const a = await pbkdf2Bits('open sesame', salt, 1000);
    const b = await pbkdf2Bits('open sesame', salt, 1000);
    expect(toHex(a)).toBe(toHex(b));
  });

  it('diverges on a different passcode or salt', async () => {
    const base = toHex(await pbkdf2Bits('open sesame', salt, 1000));
    expect(toHex(await pbkdf2Bits('open sesamf', salt, 1000))).not.toBe(base);
    expect(toHex(await pbkdf2Bits('open sesame', new Uint8Array(16).fill(8), 1000))).not.toBe(base);
  });
});

describe('notesLocked', () => {
  it('is off when there is no vault', () => {
    expect(notesLocked(false, false)).toBe(false);
    expect(notesLocked(false, true)).toBe(false);
  });

  it('hides notes until this session unlocks them', () => {
    expect(notesLocked(true, false)).toBe(true);
    expect(notesLocked(true, true)).toBe(false);
  });
});

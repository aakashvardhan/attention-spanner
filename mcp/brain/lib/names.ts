/**
 * Vault naming. A title is its file name, unique across the vault ignoring
 * case and Unicode form, and safe on Windows, Google Drive and inside [[links]].
 */

// Windows and Drive reject the first nine; "#", "^", "[" and "]" break [[links]].
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_NAME_BYTES = 255;
/** The relative path, leaving room for "G:\My Drive\brain\" inside Windows' 260. */
export const MAX_PATH_CHARS = 240;

export const nfc = (s: string): string => s.normalize('NFC');
export const titleKey = (title: string): string => nfc(title).toLowerCase();
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** FNV-1a: a short, stable suffix for names that had to be cut. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(s)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h.toString(36).padStart(6, '0').slice(-6);
}

/** The title a file can carry. `changed` means the original belongs in `aliases`. */
export function safeTitle(title: string, folder = ''): { title: string; changed: boolean } {
  const original = nfc(title).trim();
  let t = original.replace(ILLEGAL, '-').replace(/[. ]+$/, '');
  if (!t) t = 'Untitled';
  if (RESERVED.test(t)) t += '_';
  const budget = Math.min(MAX_NAME_BYTES - 3, MAX_PATH_CHARS - (folder ? folder.length + 1 : 0) - 3);
  if (bytes(t) > budget || t.length > budget) {
    const suffix = ' ' + shortHash(original);
    let chars = [...t];
    while (chars.length && (bytes(chars.join('') + suffix) > budget || (chars.join('') + suffix).length > budget)) chars = chars.slice(0, -1);
    t = chars.join('').trimEnd() + suffix;
  }
  return { title: t, changed: t !== original };
}

/** The title of the note at `path`: its file name without ".md", in NFC. */
export function titleOf(path: string): string {
  return nfc(path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, ''));
}

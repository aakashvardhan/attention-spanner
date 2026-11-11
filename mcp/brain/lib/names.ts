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

/**
 * Why notes cannot live in `folder`, or null; '' is the top folder. One rule for create_note,
 * move_note and stage_note. The index never reads hidden folders, attachments/ or sources/ (staging
 * may write verbatim pages there: `sources`), so a note put there would vanish from every tool;
 * and every folder name syncs to Windows through Drive.
 */
export function folderProblem(folder: string, sources = false): string | null {
  if (folder === '') return null;
  const parts = folder.split('/');
  if (folder.includes('\\') || parts.some((p) => p === '' || p.startsWith('.')) || /^attachments$/i.test(parts[0]) || (!sources && /^sources$/i.test(parts[0]))) {
    return `"${folder}" is not a folder notes can live in`;
  }
  for (const p of parts) {
    const safe = safeTitle(p).title;
    if (safe !== nfc(p)) return `folder "${p}" cannot be a name on Windows; use "${safe}"`;
  }
  return null;
}

/** The title of the note at `path`: its file name without ".md", in NFC. */
export function titleOf(path: string): string {
  return nfc(path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, ''));
}

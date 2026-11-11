import { retarget, type Link } from './links';
import { folderProblem, nfc, safeTitle, shortHash, titleKey, titleOf } from './names';
import { newPlanId, type Plan, type Step } from './plan';

/**
 * Plans for rename, move and delete (spec, Brain page 12, 13).
 * Links are title-only, so a move changes no link; a rename rewrites every
 * link to the old title, in bodies, embeds, properties and the starred list.
 */

export interface NoteText { path: string; text: string }
export type Planned = { ok: true; plan: Plan; rewritten: string[] } | { ok: false; error: string };
export const STARRED = '.brain/starred.json';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const linkTitle = (l: Link) => nameOf(l.target).replace(/\.md$/i, '');
const fail = (error: string): Planned => ({ ok: false, error });

function renameStarred(json: string, from: string, to: string): string {
  try {
    const list = JSON.parse(json) as unknown;
    if (!Array.isArray(list)) return json;
    return JSON.stringify(list.map((t) => (typeof t === 'string' && titleKey(t) === titleKey(from) ? to : t)));
  } catch {
    return json;
  }
}

export function planRename(a: { note: NoteText; newTitle: string; linkers: NoteText[]; titles: Map<string, string>; starred: string | null }): Planned {
  const oldTitle = titleOf(a.note.path);
  const wanted = nfc(a.newTitle).trim();
  const folder = dirOf(a.note.path);
  const safe = safeTitle(wanted, folder).title;
  if (safe !== wanted) return fail(`"${wanted}" cannot be a file name; try "${safe}"`);
  if (wanted === oldTitle) return fail('the title is unchanged');
  const owner = a.titles.get(titleKey(wanted));
  if (owner && owner !== a.note.path) return fail(`"${wanted}" is already used by ${owner}`);

  const newPath = join(folder, `${wanted}.md`);
  const isOld = (l: Link) => l.target !== '' && titleKey(linkTitle(l)) === titleKey(oldTitle);
  const rewrite = (text: string) => retarget(text, isOld, () => ({ target: wanted }));
  const own = rewrite(a.note.text);
  const caseOnly = titleKey(wanted) === titleKey(oldTitle);
  const steps: Step[] = [];
  if (caseOnly) {
    // On a case-insensitive disk, writing "SIGMOID.md" would overwrite "Sigmoid.md" and keep the old name.
    const tmp = join(folder, `.rename-${shortHash(a.note.path + wanted)}.md`);
    steps.push({ op: 'write', path: tmp, text: own }, { op: 'remove', path: a.note.path }, { op: 'write', path: newPath, text: own }, { op: 'remove', path: tmp });
  } else steps.push({ op: 'write', path: newPath, text: own });

  const rewritten: string[] = [];
  for (const l of a.linkers) {
    if (titleKey(l.path) === titleKey(a.note.path)) continue;
    const t = rewrite(l.text);
    if (t !== l.text) {
      steps.push({ op: 'write', path: l.path, text: t });
      rewritten.push(l.path);
    }
  }
  if (a.starred !== null) {
    const s = renameStarred(a.starred, oldTitle, wanted);
    if (s !== a.starred) steps.push({ op: 'write', path: STARRED, text: s });
  }
  if (!caseOnly) steps.push({ op: 'remove', path: a.note.path });
  return { ok: true, plan: { id: newPlanId(), label: `rename "${oldTitle}" to "${wanted}"`, steps }, rewritten };
}

export function planMove(a: { note: NoteText; folder: string; paths: Set<string> }): Planned {
  const folder = a.folder.replace(/^\/+|\/+$/g, '');
  const problem = folderProblem(folder);
  if (problem) return fail(problem);
  const to = join(folder, nameOf(a.note.path));
  if (titleKey(to) === titleKey(a.note.path)) return fail(`it is already in ${folder || 'the top folder'}`);
  if (a.paths.has(titleKey(to))) return fail(`${to} already exists`);
  return {
    ok: true,
    plan: { id: newPlanId(), label: `move "${titleOf(a.note.path)}" to ${folder || 'the top folder'}`, steps: [{ op: 'copy', from: a.note.path, to }, { op: 'remove', path: a.note.path }] },
    rewritten: [],
  };
}

export function planDelete(a: { note: NoteText; date: string; taken: Set<string> }): Planned {
  const dir = `.brain/trash/${a.date}`;
  const base = nameOf(a.note.path).replace(/\.md$/i, '');
  let to = `${dir}/${base}.md`;
  for (let n = 2; a.taken.has(titleKey(to)); n++) to = `${dir}/${base} ${n}.md`;
  return {
    ok: true,
    plan: { id: newPlanId(), label: `delete "${titleOf(a.note.path)}"`, steps: [{ op: 'copy', from: a.note.path, to }, { op: 'remove', path: a.note.path }] },
    rewritten: [],
  };
}

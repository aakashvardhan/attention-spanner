import { MAX_ASSISTANT_SKILLS, SKILL_MAX_CHARS } from '../shared/constants';
import { getLocal, setLocal } from '../shared/storage';
import type { AssistantSkill } from '../shared/types';

/**
 * Assistant skills — user-written instruction docs (see types.AssistantSkill).
 * All writes happen here in the service worker so options/newtab never race
 * each other (same rule as memory.ts).
 */

function clean(skill: Pick<AssistantSkill, 'name' | 'keywords' | 'body'>): {
  name: string;
  keywords: string[];
  body: string;
} {
  return {
    name: skill.name.trim().slice(0, 60),
    keywords: skill.keywords
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10),
    body: skill.body.trim().slice(0, SKILL_MAX_CHARS),
  };
}

export async function addSkill(
  input: Pick<AssistantSkill, 'name' | 'keywords' | 'body'>,
): Promise<{ ok: boolean; skill?: AssistantSkill; error?: string }> {
  const fields = clean(input);
  if (!fields.name || !fields.body) return { ok: false, error: 'A skill needs a name and a body.' };

  const { assistantSkills } = await getLocal('assistantSkills');
  if (assistantSkills.length >= MAX_ASSISTANT_SKILLS) {
    return { ok: false, error: `Skill limit reached (${MAX_ASSISTANT_SKILLS}). Delete one first.` };
  }
  const now = Date.now();
  const skill: AssistantSkill = {
    id: crypto.randomUUID(),
    ...fields,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  await setLocal({ assistantSkills: [...assistantSkills, skill] });
  return { ok: true, skill };
}

export async function updateSkill(
  id: string,
  patch: Partial<Pick<AssistantSkill, 'name' | 'keywords' | 'body' | 'enabled'>>,
): Promise<{ ok: boolean; error?: string }> {
  const { assistantSkills } = await getLocal('assistantSkills');
  const existing = assistantSkills.find((s) => s.id === id);
  if (!existing) return { ok: false, error: 'No such skill.' };

  const merged = { ...existing, ...patch };
  const fields = clean(merged);
  if (!fields.name || !fields.body) return { ok: false, error: 'A skill needs a name and a body.' };

  const updated: AssistantSkill = {
    ...merged,
    ...fields,
    updatedAt: Date.now(),
  };
  await setLocal({
    assistantSkills: assistantSkills.map((s) => (s.id === id ? updated : s)),
  });
  return { ok: true };
}

export async function deleteSkill(id: string): Promise<void> {
  const { assistantSkills } = await getLocal('assistantSkills');
  await setLocal({ assistantSkills: assistantSkills.filter((s) => s.id !== id) });
}

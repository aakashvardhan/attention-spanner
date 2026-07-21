import { SKILL_BUDGET_CHARS } from '../constants';
import { getLocal } from '../storage';
import type { AssistantSkill } from '../types';

/**
 * Skill selection: score each enabled skill against the utterance (keyword
 * hits) and the routed tool (name/keyword relevance), take the top scorers
 * that fit the prompt budget. Pure and cheap — no LLM involved in deciding
 * which written-down knowledge applies.
 */

export function scoreSkill(skill: AssistantSkill, input: string, routedTool: string | null): number {
  const text = input.toLowerCase();
  let score = 0;
  for (const raw of skill.keywords) {
    const kw = raw.trim().toLowerCase();
    if (!kw) continue;
    if (text.includes(kw)) score += 2;
    if (routedTool && (routedTool.includes(kw) || kw.includes(routedTool.split('_')[0]))) {
      score += 1;
    }
  }
  return score;
}

export function selectSkills(
  input: string,
  routedTool: string | null,
  skills: AssistantSkill[],
  budgetChars = SKILL_BUDGET_CHARS,
): AssistantSkill[] {
  const scored = skills
    .filter((s) => s.enabled && s.body.trim() !== '')
    .map((skill) => ({ skill, score: scoreSkill(skill, input, routedTool) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked: AssistantSkill[] = [];
  let used = 0;
  for (const { skill } of scored) {
    if (picked.length === 2) break;
    if (used + skill.body.length > budgetChars) continue;
    picked.push(skill);
    used += skill.body.length;
  }
  return picked;
}

/** Render selected skills as a system-prompt block */
export function buildSkillBlock(skills: AssistantSkill[]): string {
  if (skills.length === 0) return '';
  const body = skills.map((s) => `### ${s.name}\n${s.body.trim()}`).join('\n\n');
  return `\n\nUser-written instructions (follow these):\n${body}`;
}

/** Best-effort load — returns [] where storage is unreachable (tests) */
export async function loadSkills(): Promise<AssistantSkill[]> {
  try {
    const { assistantSkills } = await getLocal('assistantSkills');
    return assistantSkills;
  } catch {
    return [];
  }
}

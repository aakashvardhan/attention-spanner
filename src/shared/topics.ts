/** Topics Continue keeps. Keyword matching only; the Gemini fallback lives with the tracker. */
export const DEFAULT_TOPICS: readonly string[] = ['AI', 'robotics', 'reinforcement learning'];

// Synonym sets keyed by lower-cased topic. Seeded from the retired keyword category rules.
const SYNONYMS: Record<string, RegExp> = {
  ai: /\bAI\b|artificial intelligence|machine learning|\bML\b|deep learning|neural|\bLLMs?\b|\bGPT|transformers?\b|diffusion|reinforcement learning|\bRL\b|DeepMind|OpenAI|Anthropic|\bClaude\b|\bGemini\b|self-supervised|world models?/i,
  robotics: /\brobot(s|ic|ics)?\b|\bhumanoids?\b|\bmanipulation\b|\blocomotion\b|\bquadrupeds?\b|\bdrones?\b|\bROS\b|\bVLAs?\b|\bembodied\b|\bteleop/i,
  'reinforcement learning': /reinforcement learning|\bRL\b|\bPPO\b|\bDQN\b|policy gradient|policy optimization|Q-learning|actor-critic|\bMDPs?\b|\bbandits?\b|reward model/i,
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normalizeTrackTopics(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TOPICS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    const t = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
    if (!t || t.length > 40 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, 20);
}

/** True when the text is on any topic; no topics means the filter is off. */
export function keywordOnTopic(text: string, topics: readonly string[]): boolean {
  if (topics.length === 0) return true;
  return topics.some((topic) => {
    const rule =
      SYNONYMS[topic.toLowerCase()] ??
      new RegExp(`(?<![\\p{L}\\p{N}])${escape(topic)}(?![\\p{L}\\p{N}])`, 'iu');
    return rule.test(text);
  });
}

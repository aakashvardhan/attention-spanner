/**
 * Continue watching, sorted by what a video is: a lecture series first (the
 * format decides how you return to it), then its topic. Keyword rules over the
 * title and channel: instant, free and predictable, unlike a model call per
 * video on every new tab.
 */

// ponytail: keyword rules; a model call per new video if these misfile too often.
const RULES: [string, RegExp][] = [
  ['Lecture series', /\b(lecture|lec\.?)\s*#?\d+|\bcourse\b|\blesson\s*\d+|\bclass\s*\d+|\bseminar\b|\bCS\s?\d{3}\b|\bpart\s*\d+\s*(of|\/)\s*\d+/i],
  ['Robotics', /\brobot(s|ic|ics)?\b|\bhumanoids?\b|\bmanipulation\b|\blocomotion\b|\bquadrupeds?\b|\bdrones?\b|\bROS\b|\bVLAs?\b|\bembodied\b|\bteleop/i],
  [
    'AI',
    /\bAI\b|artificial intelligence|machine learning|\bML\b|deep learning|neural|\bLLMs?\b|\bGPT|transformers?\b|diffusion|reinforcement learning|\bRL\b|\bagents?\b|DeepMind|OpenAI|Anthropic|\bClaude\b|\bGemini\b/i,
  ],
  ['Programming', /programming|\bcod(e|ing)\b|javascript|typescript|python|\brust\b|golang|\breact\b|software|developer|\bAPI\b|algorithms?|leetcode|system design|\blinux\b|\bgit\b/i],
  ['Math & science', /\bmath|calculus|linear algebra|probability|statistics|physics|chemistry|biology|theorem|\bproofs?\b/i],
];

export function videoCategory(title: string, channel: string): string {
  // The title says what this video is; the channel is the fallback for a vague title.
  for (const text of [title, channel]) {
    for (const [category, pattern] of RULES) if (pattern.test(text)) return category;
  }
  return 'Other';
}

/** Videos by category, groups ordered by their newest video; order inside each group is kept. */
export function groupByCategory<T>(videos: readonly T[], describe: (video: T) => [title: string, channel: string]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const video of videos) {
    const category = videoCategory(...describe(video));
    groups.set(category, [...(groups.get(category) ?? []), video]);
  }
  return [...groups];
}

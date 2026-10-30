import { askGeminiOnTopic } from '../shared/llm/geminiTopic';
import { getSession, getSettings, setSession } from '../shared/storage';
import { keywordOnTopic, normalizeTrackTopics } from '../shared/topics';

/** How long a new entry waits on Gemini before it is kept anyway. */
export const TOPIC_BUDGET_MS = 1500;

type Deps = { ask?: typeof askGeminiOnTopic };

/**
 * True on a keyword match or with no topics; otherwise Gemini's answer, cached
 * per key for the session. Null means unavailable (no key, error), which keeps.
 */
export async function topicVerdict(key: string, text: string, deps: Deps = {}): Promise<boolean | null> {
  const settings = await getSettings();
  const topics = normalizeTrackTopics(settings.trackTopics);
  if (keywordOnTopic(text, topics)) return true;

  const { topicVerdicts } = await getSession('topicVerdicts');
  if (key in topicVerdicts) return topicVerdicts[key];
  if (!settings.geminiTopicKey) return null;

  const verdict = await (deps.ask ?? askGeminiOnTopic)({ apiKey: settings.geminiTopicKey, topics, text });
  if (verdict !== null) {
    // ponytail: read-modify-write; two verdicts landing at once can lose one. It is a cache.
    const { topicVerdicts: latest } = await getSession('topicVerdicts');
    await setSession({ topicVerdicts: { ...latest, [key]: verdict } });
  }
  return verdict;
}

/**
 * 'drop' only on a Gemini "no" inside the budget. A slower "no" keeps the entry
 * now and calls onLateDrop to remove it once the answer lands.
 */
export async function gateNewItem(
  key: string,
  text: string,
  onLateDrop: () => Promise<void>,
  deps: Deps = {},
): Promise<'keep' | 'drop'> {
  const verdict = topicVerdict(key, text, deps).catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), TOPIC_BUDGET_MS)));
  const first = await Promise.race([verdict, timeout]);
  clearTimeout(timer);
  if (first === 'timeout') {
    void verdict.then((late) => (late === false ? onLateDrop() : undefined)).catch(() => {});
    return 'keep';
  }
  return first === false ? 'drop' : 'keep';
}

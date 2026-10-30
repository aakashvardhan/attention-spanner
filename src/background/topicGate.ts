import { askGeminiOnTopic } from '../shared/llm/geminiTopic';
import { getSession, getSettings, setSession } from '../shared/storage';
import { keywordOnTopic, normalizeTrackTopics } from '../shared/topics';

/** How long a new entry waits on Gemini before it is kept anyway. */
export const TOPIC_BUDGET_MS = 1500;

type Deps = { ask?: typeof askGeminiOnTopic };

const inFlight = new Map<string, Promise<boolean | null>>();

/**
 * True on a keyword match or with no topics. On a keyword miss: false with no
 * Gemini key (the keyword verdict stands); otherwise Gemini's answer, cached per
 * key for the session. Null means Gemini was unavailable (error, malformed
 * answer), which keeps: those are transient.
 */
export async function topicVerdict(key: string, text: string, deps: Deps = {}): Promise<boolean | null> {
  const settings = await getSettings();
  const topics = normalizeTrackTopics(settings.trackTopics);
  if (keywordOnTopic(text, topics)) return true;

  // Keyed by topics and text too: a retitled item, or a changed topic list, is
  // a different question.
  const asked = `${topics.join('\u0001')}\u0000${key}\u0000${text}`;
  const { topicVerdicts } = await getSession('topicVerdicts');
  if (asked in topicVerdicts) return topicVerdicts[asked];
  if (!settings.geminiTopicKey) return false;

  // Back-to-back progress updates for one new page share a single call.
  const running = inFlight.get(asked);
  if (running) return running;
  const call = (async () => {
    const verdict = await (deps.ask ?? askGeminiOnTopic)({ apiKey: settings.geminiTopicKey, topics, text });
    if (verdict !== null) {
      // ponytail: read-modify-write; two verdicts landing at once can lose one. It is a cache.
      const { topicVerdicts: latest } = await getSession('topicVerdicts');
      await setSession({ topicVerdicts: { ...latest, [asked]: verdict } });
    }
    return verdict;
  })().finally(() => inFlight.delete(asked));
  inFlight.set(asked, call);
  return call;
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

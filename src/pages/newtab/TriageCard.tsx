import { useEffect, useMemo, useState } from 'react';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { embed, health } from '../../shared/llm/ollama';
import { recordStat, updateVectors } from '../../shared/llm/store';
import {
  interestProfile,
  itemText,
  newest,
  rankItems,
  unreadItems,
  type Pick,
} from '../../shared/llm/triage';
import { dequantize, quantize } from '../../shared/llm/vectors';
import { sendMessage } from '../../shared/messages';
import { progressKeyFor } from '../../shared/progress';

const SHOWN = 5;
/** Unread items considered; the first visit embeds these once, later visits hit the cache */
const CANDIDATES = 60;

/**
 * The feed, finally on screen — five unread items closest to what you finish,
 * each with the reason it is here. Feeds were fetched for months with nowhere
 * to show them; this card is that somewhere, and it stays a short list on
 * purpose. With no local model it still works, newest first, and says so.
 */
export function TriageCard() {
  const [settings, settingsLoaded] = useSettings();
  const [cachedItems, itemsLoaded] = useStorageValue('cachedItems');
  const [readItems] = useStorageValue('readItems');
  const [papers] = useStorageValue('papers');
  const [readingProgress] = useStorageValue('readingProgress');

  const unread = useMemo(() => unreadItems(cachedItems, readItems, CANDIDATES), [cachedItems, readItems]);
  // Recomputed per render, but only its contents (the signature) drive work:
  // readingProgress changes every few seconds while you read in another tab.
  const profile = interestProfile(papers, readingProgress, Date.now());
  const signature = `${settings.ollamaEmbedModel}|${unread.map((i) => i.id).join()}|${profile.map((p) => p.id).join()}`;

  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!settingsLoaded || !itemsLoaded) return;
    let alive = true;
    void rank().then((result) => {
      if (!alive) return;
      setPicks(result.picks);
      setNote(result.note);
    });
    return () => {
      alive = false;
    };

    async function rank(): Promise<{ picks: Pick[]; note: string }> {
      if (unread.length === 0) return { picks: [], note: '' };
      if (profile.length === 0) {
        return {
          picks: newest(unread, SHOWN),
          note: 'Newest first. Finish a few articles or track a paper and this learns what you read.',
        };
      }
      const up = await health(settings.ollamaUrl);
      if (!up.ok) return { picks: newest(unread, SHOWN), note: 'Newest first — local AI is off.' };

      const model = settings.ollamaEmbedModel;
      const itemKey = (id: string) => `${model}|feed:${id}`;
      const profileKey = (id: string) => `${model}|profile:${id}`;
      try {
        // Only what is not cached yet gets embedded.
        const { aiVectors } = await chrome.storage.local.get('aiVectors');
        const cached = (aiVectors ?? {}) as Record<string, string>;
        const missing = [
          ...unread.filter((i) => !cached[itemKey(i.id)]).map((i) => ({ key: itemKey(i.id), text: itemText(i) })),
          ...profile.filter((p) => !cached[profileKey(p.id)]).map((p) => ({ key: profileKey(p.id), text: p.text })),
        ];
        const fresh: Record<string, string> = {};
        if (missing.length > 0) {
          const vectors = await embed({ url: settings.ollamaUrl, model, input: missing.map((m) => m.text) });
          missing.forEach((m, i) => (fresh[m.key] = quantize(vectors[i])));
        }
        const all = { ...cached, ...fresh };
        // Keep the cache to what this card can use; other features' vectors
        // (no feed:/profile: in the key) are left alone.
        const live = new Set([...unread.map((i) => itemKey(i.id)), ...profile.map((p) => profileKey(p.id))]);
        await updateVectors((current) => {
          const next: Record<string, string> = {};
          for (const [key, value] of Object.entries({ ...current, ...fresh })) {
            const triageKey = key.includes('|feed:') || key.includes('|profile:');
            if (!triageKey || live.has(key)) next[key] = value;
          }
          return next;
        });
        const vectorOf = (key: string) => (all[key] ? dequantize(all[key]) : undefined);
        return {
          picks: rankItems(unread, (i) => vectorOf(itemKey(i.id)), profile, (p) => vectorOf(profileKey(p.id)), SHOWN),
          note: '',
        };
      } catch {
        return {
          picks: newest(unread, SHOWN),
          note: `Newest first — pull ${model} in Ollama to rank by what you read.`,
        };
      }
    }
    // `signature` stands in for unread, profile and the model.
  }, [signature, settingsLoaded, itemsLoaded, settings.ollamaUrl]);

  // No feeds, nothing to triage: no card, rather than an empty one.
  if (!itemsLoaded || cachedItems.length === 0) return null;

  return (
    <section className="edition-feed" aria-labelledby="triage-title">
      <h2 id="triage-title" className="edition-kicker">From your feeds</h2>
      {picks === null ? (
        <p className="relay-empty">Sorting by what you finish…</p>
      ) : picks.length === 0 ? (
        <p className="relay-empty">All caught up on your feeds.</p>
      ) : (
        <ul>
          {picks.map(({ item, because }) => (
            <li key={item.id}>
              <button
                className="edition-story"
                data-story
                onClick={() => {
                  void recordStat({
                    count: 'triage.opened',
                    probe: { key: progressKeyFor(item.link), startPercent: 0, recap: false, at: Date.now(), kind: 'triage' },
                  });
                  void sendMessage({ type: 'OPEN_ARTICLE', url: item.link, feedItemId: item.id, readerView: false, original: true });
                }}
              >
                <span className="edition-story-title">{item.title}</span>
                <span className="edition-story-meta">{item.source}</span>
                {because && <span className="edition-story-why">Because you read {because}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="relay-triage-note">{note}</p>}
    </section>
  );
}

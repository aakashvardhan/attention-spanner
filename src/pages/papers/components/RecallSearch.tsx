import { useMemo, useRef, useState } from 'react';
import { useSettings } from '../../../shared/hooks/useSettings';
import { useStorageValue } from '../../../shared/hooks/useStorageValue';
import { recallEntries, searchRecall, type RecallEntry } from '../../../shared/llm/recall';
import { recordStat } from '../../../shared/llm/store';

/**
 * "Search your highlights" — by meaning, not spelling, across every highlight,
 * note and abstract you have. On device only.
 */
export function RecallSearch() {
  const [settings] = useSettings();
  const [annotations] = useStorageValue('annotations');
  const [papers] = useStorageValue('papers');
  const entries = useMemo(() => recallEntries(annotations, papers), [annotations, papers]);

  const [query, setQuery] = useState('');
  const [state, setState] = useState<
    { status: 'idle' } | { status: 'searching' } | { status: 'done'; hits: RecallEntry[] } | { status: 'error'; message: string }
  >({ status: 'idle' });
  const latest = useRef(0);

  if (entries.length === 0) return null;

  const search = async () => {
    const id = ++latest.current;
    setState({ status: 'searching' });
    try {
      const hits = await searchRecall(query, entries, settings, 8);
      if (id !== latest.current) return;
      setState({ status: 'done', hits: hits.map((h) => h.entry) });
      void recordStat({ count: 'recall.searched' });
    } catch {
      if (id !== latest.current) return;
      setState({
        status: 'error',
        message: `Search needs Ollama running with ${settings.ollamaEmbedModel} pulled.`,
      });
    }
  };

  return (
    <section className="panel recall" aria-labelledby="recall-title">
      <h2 id="recall-title">Search your highlights</h2>
      <form
        className="recall-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) void search();
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What did I read about attention sinks?"
          aria-label="Search your highlights by meaning"
        />
        <button type="submit" className="fc-primary-btn" disabled={!query.trim() || state.status === 'searching'}>
          Search
        </button>
      </form>
      {state.status === 'searching' && <p className="recall-hint">Searching {entries.length} highlights and abstracts…</p>}
      {state.status === 'error' && <p className="recall-hint">{state.message}</p>}
      {state.status === 'done' && (
        <ul className="recall-results">
          {state.hits.map((entry) => (
            <li key={entry.key}>
              <button
                onClick={() => {
                  void recordStat({ count: 'recall.clicked' });
                  void chrome.tabs.create({ url: entry.url });
                }}
              >
                <span className="recall-quote">{entry.quote}</span>
                <small>{entry.title}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="recall-hint">Matches by meaning, on this device. Nothing is sent anywhere.</p>
    </section>
  );
}

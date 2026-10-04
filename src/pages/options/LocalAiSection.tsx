import { useCallback, useEffect, useState } from 'react';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { LAYA_URL_DEFAULT } from '../../shared/constants';
import { layaHealth, type LayaHealth } from '../../shared/llm/laya';
import { health, type Health } from '../../shared/llm/ollama';
import { patchSettings } from '../../shared/storage';
import type { AiStats, CloudMode, Settings } from '../../shared/types';
import { TextRow } from './NewTabSection';

/**
 * Onboarding for on-device AI. Ollama support was deleted once before because
 * nothing in the UI ever set it up — so this section's job is to get from
 * "installed Ollama" to "it works" without reading a README, including the one
 * step everybody trips on: Ollama 403s extension origins until told otherwise.
 */
export function LocalAiSection({ settings }: { settings: Settings }) {
  const [status, setStatus] = useState<Health | null>(null);
  const [aiStats] = useStorageValue('aiStats');

  const test = useCallback(async () => {
    setStatus(null);
    setStatus(await health(settings.ollamaUrl));
  }, [settings.ollamaUrl]);

  useEffect(() => {
    void test();
  }, [test]);

  const models = status?.ok ? status.models : [];
  const origin = `chrome-extension://${chrome.runtime.id}`;

  return (
    <section className="section" id="local-ai">
      <h2>Local AI</h2>
      <p className="hint">
        Recaps, feed triage, document questions and highlight search run on your own machine
        through <a href="https://ollama.com" target="_blank" rel="noreferrer">Ollama</a>. Nothing
        you read leaves this computer unless you allow the cloud below, and even then only public
        sources do.
      </p>

      <TextRow
        id="ollama-url"
        label="Ollama address"
        placeholder="http://localhost:11434"
        value={settings.ollamaUrl}
        onCommit={(ollamaUrl) => void patchSettings({ ollamaUrl: ollamaUrl || 'http://localhost:11434' })}
      />
      <div className="setting-row">
        <span>
          {status === null
            ? 'Checking…'
            : status.ok
              ? `Connected · ${models.length} model${models.length === 1 ? '' : 's'} installed`
              : status.kind === 'forbidden'
                ? 'Ollama is running but refusing this extension'
                : 'Ollama is not answering'}
        </span>
        <button type="button" onClick={() => void test()}>
          Test again
        </button>
      </div>

      {status && !status.ok && (
        <div className="ai-setup">
          <p className="hint">
            {status.kind === 'forbidden'
              ? 'Allow this extension, then quit and reopen Ollama:'
              : 'Start Ollama (open the app, or run ollama serve). If it is already running, it may be refusing this extension — allow it, then quit and reopen Ollama:'}
          </p>
          <code className="ai-setup-cmd">launchctl setenv OLLAMA_ORIGINS "{origin}"</code>
          <p className="hint">
            That is the macOS form. On Linux set the same OLLAMA_ORIGINS variable on the Ollama
            service; on Windows, in the system environment variables.
          </p>
        </div>
      )}

      {status?.ok && (
        <>
          <div className="setting-row">
            <label htmlFor="ollama-chat-model">Writing model</label>
            <select
              id="ollama-chat-model"
              value={settings.ollamaChatModel}
              onChange={(e) => void patchSettings({ ollamaChatModel: e.target.value })}
            >
              <option value="">Choose…</option>
              {withCurrent(models, settings.ollamaChatModel).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <label htmlFor="ollama-embed-model">Search model</label>
            <select
              id="ollama-embed-model"
              value={settings.ollamaEmbedModel}
              onChange={(e) => void patchSettings({ ollamaEmbedModel: e.target.value })}
            >
              {withCurrent(models, settings.ollamaEmbedModel).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          {models.length === 0 || !models.some((m) => m.startsWith(settings.ollamaEmbedModel)) ? (
            <p className="hint">
              Suggested: <code>ollama pull qwen3:8b</code> for writing and{' '}
              <code>ollama pull nomic-embed-text</code> for search.
            </p>
          ) : null}
        </>
      )}

      <LayaRows url={settings.layaUrl} />

      <div className="setting-row">
        <label htmlFor="cloud-mode">Cloud for public sources</label>
        <select
          id="cloud-mode"
          value={settings.cloudMode}
          onChange={(e) => void patchSettings({ cloudMode: e.target.value as CloudMode })}
        >
          <option value="off">Never</option>
          <option value="ask">Ask each time</option>
          <option value="public">When the local model can't</option>
        </select>
      </div>
      {settings.cloudMode !== 'off' && (
        <TextRow
          id="claude-key"
          label="Anthropic API key"
          placeholder="sk-ant-…"
          type="password"
          value={settings.claudeKey}
          onCommit={(claudeKey) => void patchSettings({ claudeKey })}
        />
      )}
      <p className="hint">
        Public means feed items, arXiv and DOI papers, and YouTube videos. Web pages, local PDFs
        and your highlights are always treated as private — a signed-in page cannot be told apart
        from a public one, so none of them is ever sent. A brain dump goes to Claude Haiku only when
        the local model can't answer and you click Ask Claude Haiku on that dump. The key is stored
        only in this browser.
      </p>

      <ImpactRows stats={aiStats} />
    </section>
  );
}

/**
 * Laya answers questions with probabilities rather than text: which deck a
 * paper belongs in, what a highlight is, whether a tab is off-task. It runs as
 * its own small server because it needs Node, not a browser.
 */
function LayaRows({ url }: { url: string }) {
  const [status, setStatus] = useState<LayaHealth | null>(null);

  const test = useCallback(async () => {
    setStatus(null);
    if (url) setStatus(await layaHealth(url));
  }, [url]);

  useEffect(() => {
    void test();
  }, [test]);

  return (
    <>
      <h3 className="ai-subhead">Decisions</h3>
      <p className="hint">
        Optional. <a href="https://github.com/receptron/laya" target="_blank" rel="noreferrer">Laya</a>{' '}
        suggests a deck and type for new papers, sorts your highlights into a literature
        matrix, sharpens feed triage and notices off-task tabs during focus. It needs about 2 GB of
        memory; start it with <code>node scripts/laya-server/server.mjs</code>. Leave the address
        empty to turn it off.
      </p>
      <TextRow
        id="laya-url"
        label="Laya address"
        placeholder={LAYA_URL_DEFAULT}
        value={url}
        onCommit={(layaUrl) => void patchSettings({ layaUrl })}
      />
      {url && (
        <div className="setting-row">
          <span>
            {status === null
              ? 'Checking…'
              : !status.ok
                ? 'Laya is not answering'
                : status.ready
                  ? 'Ready'
                  : 'Loading the model (the first start downloads 1.7 GB)'}
          </span>
          <button type="button" onClick={() => void test()}>
            Test again
          </button>
        </div>
      )}
    </>
  );
}

function withCurrent(models: string[], current: string): string[] {
  return current && !models.includes(current) ? [current, ...models] : models;
}

function rate(hit: number | undefined, total: number | undefined): string | null {
  if (!total) return null;
  return `${Math.round(((hit ?? 0) / total) * 100)}% of ${total}`;
}

/**
 * The measurable part. Plain sentences over counts the features record locally
 * (llm/store.ts); a row stays hidden until it has data behind it.
 */
function ImpactRows({ stats }: { stats: AiStats }) {
  const c = stats.counts;
  const withRecap = rate(c['resume.withRecap.advanced'], c['resume.withRecap']);
  const withoutRecap = rate(c['resume.withoutRecap.advanced'], c['resume.withoutRecap']);
  const triage = rate(c['triage.finished'], c['triage.opened']);
  const cited = rate(c['ask.cited'], c['ask.answered']);
  const search = rate(c['recall.clicked'], c['recall.searched']);
  const related = rate(c['related.clicked'], c['related.shown']);
  const local = stats.latencies.filter((l) => l.target === 'ollama').map((l) => l.ms);
  const median = local.length ? [...local].sort((a, b) => a - b)[Math.floor(local.length / 2)] : null;

  const rows = [
    withRecap && `Resumed with a recap, then read on: ${withRecap}${withoutRecap ? ` (without: ${withoutRecap})` : ''}`,
    triage && `Triage picks opened and finished: ${triage}`,
    cited && `Answers backed by a source passage: ${cited}`,
    search && `Highlight searches that found something you opened: ${search}`,
    related && `Related-highlight suggestions you followed: ${related}`,
    median !== null && `Median on-device answer time: ${(median / 1000).toFixed(1)}s`,
  ].filter(Boolean);

  if (rows.length === 0) return null;
  return (
    <div className="ai-impact">
      <h3>What it has done for you</h3>
      <ul>
        {rows.map((row) => (
          <li key={row as string}>{row}</li>
        ))}
      </ul>
      <p className="hint">Counted on this device only.</p>
    </div>
  );
}

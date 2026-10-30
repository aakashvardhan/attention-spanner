import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ASK_TIMEOUT_MS,
  FAILED_MESSAGE,
  MAX_DUMP_CHARS,
  NO_KEY_MESSAGE,
  REFRAME_SYSTEM,
  parseReframe,
} from '../../shared/brainDump';
import { CLAUDE_MODELS } from '../../shared/constants';
import { useSettings } from '../../shared/hooks/useSettings';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { claudeStream } from '../../shared/llm/claude';
import { getLocal, setLocal, withDumpLock } from '../../shared/storage';
import type { DumpEntry, Vault } from '../../shared/types';
import { sealEntry } from '../../shared/vault';
import { Icon } from './Icon';
import { VaultSetup } from './VaultSetup';

/** Quiet time after an edit in the failed state before the words are re-saved */
const EDIT_SAVE_MS = 800;

type Phase = 'writing' | 'streaming' | 'bullets' | 'setup' | 'failed';

/** The unsent draft, kept across a remount, never stored. */
let draftMemo = '';
/**
 * The id the draft's words are saved under, kept beside the draft: a retry,
 * or a resubmit after a remount, replaces that copy instead of adding one.
 */
let savedIdMemo: string | null = null;

/**
 * Empty your head, Cmd+Enter, and Claude Haiku hands it back as a few gentle
 * reframes. The words and the bullets lock away together; past dumps are never
 * shown here, only counted. Reading them back is a deliberate trip to the
 * entries page with the passphrase.
 */
export function BrainDump() {
  const [settings] = useSettings();
  const [vault] = useStorageValue('vault');
  const [locked] = useStorageValue('lockedDumps');
  const [text, setTextState] = useState(() => draftMemo);
  const setText = (next: string) => {
    draftMemo = next;
    setTextState(next);
  };
  const [phase, setPhase] = useState<Phase>('writing');
  const [live, setLive] = useState('');
  const [bullets, setBullets] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState<(DumpEntry & { id: string }) | null>(null);
  /** The words as last saved after a failed ask, so a close only re-saves real edits */
  const savedText = useRef('');
  const inFlight = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => inFlight.current?.abort(), []);
  // The box remounts after a failed ask; the cursor goes back so Cmd+Enter retries at once.
  // Not on load: a focused box would swallow J/K and C before they reach the page.
  useEffect(() => {
    if (phase !== 'failed') return;
    const box = inputRef.current;
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  }, [phase]);

  /**
   * Lock (or, before setup, park in the clear) under one id; a second save
   * replaces the first. Returns the vault it sealed with, read fresh: another
   * tab may have finished setup since this one rendered.
   */
  function save(entry: DumpEntry, id: string): Promise<Vault | null> {
    return withDumpLock(async () => {
      const stored = await getLocal('vault', 'lockedDumps', 'dumps');
      if (stored.vault) {
        const sealed = await sealEntry(stored.vault.publicKey, entry, id);
        await setLocal({ lockedDumps: [sealed, ...stored.lockedDumps.filter((d) => d.id !== id)] });
        return stored.vault;
      }
      const raw = { id, text: entry.text, createdAt: entry.createdAt };
      await setLocal({ dumps: [raw, ...stored.dumps.filter((d) => d.id !== id)] });
      return null;
    });
  }

  /** Words saved after a failed ask, under the draft's id */
  async function saveFailed(words: string, createdAt: number) {
    savedText.current = words;
    await save({ text: words, bullets: [], createdAt }, (savedIdMemo ??= crypto.randomUUID()));
  }

  // Edits made after a failed ask are saved once typing pauses, so closing
  // the tab without a retry keeps them. A closing page can't be trusted to
  // finish an encrypt-and-write, so pagehide alone is only a backstop.
  useEffect(() => {
    if (phase !== 'failed') return;
    const flush = () => {
      const words = draftMemo.trim();
      if (words && words !== savedText.current) void saveFailed(words, Date.now());
    };
    const timer = setTimeout(flush, EDIT_SAVE_MS);
    addEventListener('pagehide', flush);
    return () => {
      clearTimeout(timer);
      removeEventListener('pagehide', flush);
    };
  }, [phase, text]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit() {
    const words = text.trim();
    if (!words || (phase !== 'writing' && phase !== 'failed')) return;
    const id = (savedIdMemo ??= crypto.randomUUID());
    const createdAt = Date.now();
    if (!settings.claudeKey) {
      await saveFailed(words, createdAt);
      setError(NO_KEY_MESSAGE);
      setPhase('failed');
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    setPhase('streaming');
    setError('');
    setLive('');
    try {
      const reply = await claudeStream({
        apiKey: settings.claudeKey,
        model: CLAUDE_MODELS.quick,
        system: REFRAME_SYSTEM,
        document: words,
        prompt: 'Give this back to me a little lighter.',
        signal: controller.signal,
        onText: setLive,
      });
      const parsed = parseReframe(reply);
      if (!parsed.length) throw new Error('no bullets');
      const entry = { text: words, bullets: parsed, createdAt };
      const sealedWith = await save(entry, id);
      savedIdMemo = null;
      setText('');
      setBullets(parsed);
      if (sealedWith) setPhase('bullets');
      else {
        setCurrent({ ...entry, id });
        setPhase('setup');
      }
    } catch {
      if (inFlight.current !== controller) return;
      // The words are never lost: locked raw now, replaced if a retry works.
      await saveFailed(words, createdAt);
      setError(FAILED_MESSAGE);
      setPhase('failed');
    } finally {
      clearTimeout(timer);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  const shown = phase === 'streaming' ? parseReframe(live) : bullets;
  const count = locked.length;

  return (
    <section className="notebook" aria-label="Brain dump">
      <p className="notebook-kicker">
        <Icon name="lock" className="notebook-lock" />
        {phase === 'bullets' || phase === 'setup' || phase === 'streaming'
          ? 'A little lighter. Locking away when you leave.'
          : 'Only Haiku reads this. Then it locks.'}
      </p>

      {phase === 'writing' || phase === 'failed' ? (
        <textarea
          ref={inputRef}
          className="notebook-input"
          aria-label="Empty your head here"
          placeholder="Empty your head here"
          maxLength={MAX_DUMP_CHARS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <ul className="notebook-bullets" aria-live="polite">
          {shown.map((line, i) => (
            <li key={i}>
              <span>
                <Words text={line} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {phase === 'setup' && current && (
        <VaultSetup
          current={current}
          existing={vault}
          onDone={(usedExisting) => {
            setCurrent(null);
            setPhase('bullets');
            if (usedExisting) setError('Locked with the passphrase you set in another tab.');
          }}
        />
      )}

      <div className="notebook-foot">
        {error ? (
          <span className="notebook-note" role="alert">
            {error}
          </span>
        ) : (
          count > 0 &&
          vault && (
            <a className="notebook-count" href={chrome.runtime.getURL('src/pages/dumps/index.html')}>
              <Icon name="lock" className="notebook-lock" />
              {count} locked
            </a>
          )
        )}
        {(phase === 'writing' || phase === 'failed') && (
          <span className="notebook-keys">
            <kbd>⌘</kbd>
            <kbd>↵</kbd>
            {phase === 'failed' ? 'try again' : 'when you are done'}
          </span>
        )}
      </div>
    </section>
  );
}

/**
 * Text as words that each settle into focus. Index keys, so as a reply streams
 * only the newly arrived words animate; spaces stay inside the spans so the
 * line wraps where it would anyway.
 */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(/(?<=\s)/).map((word, i) => (
        <span key={i} className="dump-word">
          {word}
        </span>
      ))}
    </>
  );
}

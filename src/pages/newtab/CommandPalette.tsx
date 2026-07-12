import { useEffect, useMemo, useRef, useState } from 'react';
import { executeTool, runAssistantTurn } from '../../shared/ai/assistant';
import { scoreCommand } from '../../shared/ai/fuzzy';
import { geminiProvider } from '../../shared/ai/geminiProvider';
import { nanoProvider } from '../../shared/ai/nanoProvider';
import { TOOLS, type Tool } from '../../shared/ai/tools';
import { FLASHCARDS_PAGE_PATH, PAPERS_PAGE_PATH } from '../../shared/constants';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { DEFAULT_SETTINGS } from '../../shared/storage';

/**
 * Cmd/Ctrl+K launcher on the newtab. Commands run straight through the tool
 * registry — no LLM, no confirm chip (picking the command IS the confirmation).
 * Queries that match nothing fall through to the assistant.
 */

interface PaletteCommand {
  id: string;
  label: string;
  keywords: string[];
  /** Present = the command takes one free-text argument */
  argPlaceholder?: string;
  run: (arg: string) => Promise<string>;
}

/** First required string param receives the palette argument */
function argParamOf(tool: Tool): string | null {
  for (const key of tool.params.required) {
    if (tool.params.properties[key]?.type === 'string') return key;
  }
  return null;
}

function buildCommands(): PaletteCommand[] {
  const commands: PaletteCommand[] = [];
  for (const tool of TOOLS) {
    if (!tool.palette || tool.name === 'open_page') continue;
    const argKey = argParamOf(tool);
    commands.push({
      id: tool.name,
      label: tool.palette.label,
      keywords: tool.palette.keywords,
      argPlaceholder: argKey ? tool.palette.argPlaceholder : undefined,
      run: (arg) => executeTool(tool.name, argKey && arg ? { [argKey]: arg } : {}),
    });
  }
  const nav = (id: string, label: string, keywords: string[], open: () => Promise<unknown>) =>
    commands.push({
      id,
      label,
      keywords,
      run: async () => {
        await open();
        return `Opened ${label.replace('Open ', '').toLowerCase()}.`;
      },
    });
  nav('nav-flashcards', 'Open flashcards', ['cards', 'study', 'anki'], () =>
    chrome.tabs.create({ url: chrome.runtime.getURL(FLASHCARDS_PAGE_PATH) }),
  );
  nav('nav-papers', 'Open papers', ['research', 'reading'], () =>
    chrome.tabs.create({ url: chrome.runtime.getURL(PAPERS_PAGE_PATH) }),
  );
  nav('nav-settings', 'Open settings', ['options', 'preferences'], () =>
    chrome.runtime.openOptionsPage(),
  );
  return commands;
}

type Footer =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'result'; text: string; error?: boolean }
  | { state: 'confirm'; toolName: string; params: Record<string, unknown>; summary: string };

export function CommandPalette() {
  const [storedSettings] = useStorageValue('settings');
  const assistantEnabled = { ...DEFAULT_SETTINGS, ...storedSettings }.assistantEnabled;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [argFor, setArgFor] = useState<PaletteCommand | null>(null);
  const [footer, setFooter] = useState<Footer>({ state: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const commands = useMemo(buildCommands, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, argFor]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setSel(0);
    setArgFor(null);
    setFooter({ state: 'idle' });
  };

  const matches = useMemo(() => {
    if (argFor) return [];
    const q = query.trim();
    if (!q) return commands.slice(0, 8);
    return commands
      .map((c) => ({ c, score: scoreCommand(q, c.label, c.keywords) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((m) => m.c);
  }, [commands, query, argFor]);

  const askRow = !argFor && query.trim().length > 0 && assistantEnabled;
  const rowCount = matches.length + (askRow ? 1 : 0);
  const clampedSel = Math.min(sel, Math.max(0, rowCount - 1));

  const runCommand = async (command: PaletteCommand, arg: string) => {
    if (command.argPlaceholder && !arg) {
      setArgFor(command);
      setQuery('');
      setSel(0);
      return;
    }
    setFooter({ state: 'busy' });
    try {
      const text = await command.run(arg);
      setFooter({ state: 'result', text });
      setQuery('');
      setArgFor(null);
    } catch (err) {
      setFooter({
        state: 'result',
        text: err instanceof Error ? err.message : 'That failed.',
        error: true,
      });
    }
  };

  const ask = async (q: string) => {
    setFooter({ state: 'busy' });
    try {
      const outcome = await runAssistantTurn(q, [], {
        nano: nanoProvider,
        cloud: geminiProvider,
      });
      if (outcome.kind === 'confirm') {
        setFooter({
          state: 'confirm',
          toolName: outcome.toolName,
          params: outcome.params,
          summary: outcome.summary,
        });
      } else {
        setFooter({
          state: 'result',
          text: outcome.kind === 'error' ? outcome.text : outcome.text,
          error: outcome.kind === 'error',
        });
      }
      setQuery('');
    } catch {
      setFooter({ state: 'result', text: 'Something went wrong.', error: true });
    }
  };

  const confirmPending = async () => {
    if (footer.state !== 'confirm') return;
    const { toolName, params } = footer;
    setFooter({ state: 'busy' });
    try {
      setFooter({ state: 'result', text: await executeTool(toolName, params) });
    } catch (err) {
      setFooter({
        state: 'result',
        text: err instanceof Error ? err.message : 'That failed.',
        error: true,
      });
    }
  };

  const onSubmit = () => {
    if (footer.state === 'busy') return;
    if (argFor) {
      void runCommand(argFor, query.trim());
      return;
    }
    if (clampedSel < matches.length && matches[clampedSel]) {
      void runCommand(matches[clampedSel], '');
    } else if (askRow) {
      void ask(query.trim());
    }
  };

  if (!open) return null;

  return (
    <div className="cp-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="cp-box" role="dialog" aria-label="Command palette">
        {argFor && (
          <p className="cp-arg-label">
            {argFor.label}
            <button className="cp-arg-back" onClick={() => setArgFor(null)}>
              ← back
            </button>
          </p>
        )}
        <input
          ref={inputRef}
          className="cp-input"
          value={query}
          placeholder={argFor ? (argFor.argPlaceholder ?? '') : 'Type a command or ask anything…'}
          onChange={(e) => {
            setQuery(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, rowCount - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        {!argFor && (
          <div className="cp-list">
            {matches.map((command, i) => (
              <button
                key={command.id}
                className={i === clampedSel ? 'cp-row selected' : 'cp-row'}
                onMouseEnter={() => setSel(i)}
                onClick={() => void runCommand(command, '')}
              >
                {command.label}
                {command.argPlaceholder && <span className="cp-row-arg">{command.argPlaceholder}</span>}
              </button>
            ))}
            {askRow && (
              <button
                className={clampedSel === matches.length ? 'cp-row selected' : 'cp-row'}
                onMouseEnter={() => setSel(matches.length)}
                onClick={() => void ask(query.trim())}
              >
                💬 Ask: “{query.trim()}”
              </button>
            )}
            {rowCount === 0 && <p className="cp-empty">No matching commands.</p>}
          </div>
        )}
        {footer.state === 'busy' && <p className="cp-footer">Working…</p>}
        {footer.state === 'result' && (
          <p className={footer.error ? 'cp-footer error' : 'cp-footer'}>{footer.text}</p>
        )}
        {footer.state === 'confirm' && (
          <div className="cp-footer">
            <p className="cp-confirm-text">{footer.summary}</p>
            <div className="cp-confirm-actions">
              <button className="cp-confirm-yes" onClick={() => void confirmPending()}>
                ✓ Do it
              </button>
              <button className="cp-confirm-no" onClick={() => setFooter({ state: 'idle' })}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

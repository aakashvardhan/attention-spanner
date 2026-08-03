import { alphaxivPaperRef, buildDiscoverArgs } from '../shared/alphaxiv';
import { getLocal, setLocal } from '../shared/storage';
import { connect, disconnect } from './alphaxivAuth';
import { callTool, resetSession } from './alphaxivMcp';

/**
 * The alphaXiv features the rest of the extension can reach, one function per
 * router message. Every tool call funnels through here so pages never name an
 * alphaXiv tool directly — in particular, the destructive library tools
 * (remove_papers_from_folder, delete_folder, rename_folder) are deliberately
 * not wired to anything.
 */

export type AlphaxivResult = { ok: true; text: string } | { ok: false; error: string };

async function run(name: string, args: Record<string, unknown>): Promise<AlphaxivResult> {
  try {
    return { ok: true, text: await callTool(name, args) };
  } catch (err) {
    const error = (err as Error).message || 'alphaXiv request failed.';
    const { alphaxiv } = await getLocal('alphaxiv');
    if (alphaxiv.lastError !== error) await setLocal({ alphaxiv: { ...alphaxiv, lastError: error } });
    return { ok: false, error };
  }
}

export async function axConnect(): Promise<{ ok: boolean; email?: string; error?: string }> {
  resetSession();
  return connect();
}

export async function axDisconnect(): Promise<{ ok: boolean }> {
  resetSession();
  return disconnect();
}

/** Folders and their contents — also the connection's smoke test. */
export function axLibrary(): Promise<AlphaxivResult> {
  return run('list_library', {});
}

export function axDiscover(topic: string, recent = false): Promise<AlphaxivResult> {
  if (!topic.trim()) return Promise.resolve({ ok: false, error: 'Give me a topic to search for.' });
  return run('discover_papers', { ...buildDiscoverArgs(topic, recent) });
}

export function axPaperContent(paper: string, fullText = false): Promise<AlphaxivResult> {
  const ref = alphaxivPaperRef(paper);
  if (!ref) {
    return Promise.resolve({
      ok: false,
      error: "alphaXiv can only read papers it can find online — that one isn't reachable by URL.",
    });
  }
  return run('get_paper_content', { url: ref, ...(fullText ? { fullText: true } : {}) });
}

/** Page-level excerpts answering `queries` about one paper. */
export function axAskPdf(paper: string, queries: string[]): Promise<AlphaxivResult> {
  const ref = alphaxivPaperRef(paper);
  if (!ref) {
    return Promise.resolve({
      ok: false,
      error: "alphaXiv can't open this PDF — it only reads papers available at a public URL.",
    });
  }
  return run('answer_pdf_queries', { paper: ref, queries });
}

/** Save to alphaXiv's default 'Want to read' folder. */
export function axSavePaper(paper: string): Promise<AlphaxivResult> {
  const ref = alphaxivPaperRef(paper);
  if (!ref) {
    return Promise.resolve({ ok: false, error: 'That needs to be an arXiv id or paper URL.' });
  }
  return run('save_papers_to_folder', { paper_ids_or_urls: [ref] });
}

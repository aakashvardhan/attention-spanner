import { parsePaperRef } from './papers';

/**
 * alphaXiv connection state and pure helpers. The IO lives in
 * src/background/alphaxiv*.ts (service worker only — that's where the tokens
 * are and where host permissions exempt us from CORS); everything here is
 * shape and string work so it can be unit-tested and imported from pages.
 */

export interface AlphaxivState {
  connected: boolean;
  /** Signed-in account, for display; '' when the token carried no email claim. */
  email: string;
  /** From dynamic client registration — survives disconnect so we register once. */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry (ms epoch); 0 = unknown, treat as expired. */
  expiresAt: number;
  /** Last surfaced error; '' = healthy. */
  lastError: string;
  /** deckId → alphaXiv folder_id, created lazily on first push. */
  folderByDeck: Record<string, string>;
  /** alphaXiv's default reading-status folders, resolved once from list_library. */
  statusFolders: { wantToRead: string; reading: string; completed: string };
}

export const ALPHAXIV_DEFAULTS: AlphaxivState = {
  connected: false,
  email: '',
  clientId: '',
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  lastError: '',
  folderByDeck: {},
  statusFolders: { wantToRead: '', reading: '', completed: '' },
};

/**
 * The bare arXiv id behind a reference, or null. Built on `parsePaperRef` so
 * abs/pdf/versioned links and bare ids collapse the same way the paper tracker
 * already collapses them.
 */
export function arxivIdFrom(input: string): string | null {
  const ref = parsePaperRef(input);
  return ref?.startsWith('arXiv:') ? ref.slice('arXiv:'.length) : null;
}

/**
 * What to hand alphaXiv's `paper` parameter. It resolves arXiv ids, arXiv /
 * alphaXiv / Semantic Scholar pages, and direct PDF links — so prefer the bare
 * id when we can derive one, and otherwise pass an http(s) URL through
 * untouched. Returns null when there's nothing the server could resolve
 * (a file:// or blob: PDF, say), which is the caller's cue to stay local.
 */
export function alphaxivPaperRef(input: string): string | null {
  const id = arxivIdFrom(input);
  if (id) return id;
  return /^https?:\/\//i.test(input.trim()) ? input.trim() : null;
}

/* ---- answer_pdf_queries output ------------------------------------------
   The tool is a retriever, not an answerer: it returns the pages of one paper
   that match the queries, as `<paper id="…"><page num="N">…</page>…</paper>`.
   Parsed with regexes rather than DOMParser because this also runs in the
   service worker, which has no DOM. */

export interface PaperPage {
  num: number;
  text: string;
}

export interface PagesAnswer {
  /** The paper the server actually resolved (a title lookup may land elsewhere) */
  paperId: string | null;
  pages: PaperPage[];
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/**
 * Pull the pages out of an `answer_pdf_queries` payload. An empty `pages` means
 * the response wasn't in the documented shape — callers fall back to the raw
 * text rather than showing nothing.
 */
export function parsePagesXml(xml: string): PagesAnswer {
  const paperId = xml.match(/<paper[^>]*\bid="([^"]*)"/i)?.[1] ?? null;
  const pages: PaperPage[] = [];
  const re = /<page[^>]*\bnum="(\d+)"[^>]*>([\s\S]*?)<\/page>/gi;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    const text = decodeEntities(m[2]).replace(/\s+/g, ' ').trim();
    if (text) pages.push({ num: Number(m[1]), text });
  }
  return { paperId, pages };
}

/** Everything the pages say, labelled — the context an answer is composed from. */
export function pagesToContext(answer: PagesAnswer): string {
  return answer.pages.map((p) => `[page ${p.num}] ${p.text}`).join('\n\n');
}

/**
 * Readable excerpts for a surface with no model behind it (the assistant's
 * ask_paper tool prints its result verbatim). Quotes the first few pages.
 */
export function formatPageExcerpts(answer: PagesAnswer, maxPages = 3, maxChars = 400): string {
  return answer.pages
    .slice(0, maxPages)
    .map((p) => {
      const text = p.text.length > maxChars ? `${p.text.slice(0, maxChars).trimEnd()}…` : p.text;
      return `Page ${p.num}: ${text}`;
    })
    .join('\n\n');
}

/* ---- list_library output -------------------------------------------------
   JSON: `{ "folders": [{ folder_id, name, type, parent_id, sharing_status,
   paper_count }, …] }`. Only the shelf names and counts are worth showing. */

export interface LibraryFolder {
  name: string;
  paperCount: number;
}

/** Folders in a `list_library` payload; empty when it wasn't a shape we know. */
export function parseLibraryFolders(raw: string): LibraryFolder[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : (data as { folders?: unknown } | null)?.folders;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const folder = entry as { name?: unknown; paper_count?: unknown };
    if (typeof folder.name !== 'string' || !folder.name) return [];
    const count = folder.paper_count;
    return [{ name: folder.name, paperCount: typeof count === 'number' ? count : 0 }];
  });
}

/** How many folders the summary names before counting the rest. */
const NAMED_FOLDERS = 4;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * One sentence for the options page's "Test connection" button. The raw tool
 * output is folder JSON, which tells a reader nothing they wanted to know: the
 * question being answered is "did the connection work, and is this my library".
 */
export function summarizeLibrary(raw: string): string {
  const folders = parseLibraryFolders(raw);
  if (!folders.length) return 'Connected to alphaXiv.';

  const papers = folders.reduce((n, f) => n + f.paperCount, 0);
  if (!papers) return `Connected — ${plural(folders.length, 'folder')}, no papers saved yet.`;

  const filled = folders.filter((f) => f.paperCount > 0).sort((a, b) => b.paperCount - a.paperCount);
  const named = filled.slice(0, NAMED_FOLDERS).map((f) => `${f.name} (${f.paperCount})`);
  const rest = filled.length - named.length;
  const shelves = named.join(', ') + (rest > 0 ? `, and ${plural(rest, 'more folder')}` : '');
  return `Connected — ${plural(papers, 'paper')} across ${plural(folders.length, 'folder')}: ${shelves}.`;
}

/** How hard discovery digs. Mid-scale: higher multiplies server-side rounds. */
export const DISCOVER_DIFFICULTY = 5;

/** Words that carry no retrieval signal in a phrase like "recent papers on X" */
const TOPIC_NOISE = new Set([
  'a', 'about', 'all', 'and', 'any', 'are', 'find', 'for', 'from', 'get', 'in', 'into', 'latest',
  'me', 'new', 'newest', 'of', 'on', 'paper', 'papers', 'recent', 'research', 'show', 'some',
  'that', 'the', 'to', 'with', 'work',
]);

export interface DiscoverArgs {
  keywords: string[];
  question: string;
  difficulty: number;
  prioritize?: 'default' | 'historical' | 'recency';
}

/**
 * Turn a plain topic into `discover_papers` arguments. The tool wants three
 * required fields (keywords, a semantic question, an effort number); asking a
 * Nano-sized model to fill all three reliably is a losing bet, so derive them:
 * keywords are the topic's content words, the question is the topic itself.
 */
export function buildDiscoverArgs(topic: string, recent = false): DiscoverArgs {
  const words = topic.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*/g) ?? [];
  const keywords = words.filter((w) => w.length > 1 && !TOPIC_NOISE.has(w)).slice(0, 4);
  return {
    // The tool requires keywords; if the topic was all filler, its own words
    // are still a better probe than an empty list.
    keywords: keywords.length ? keywords : words.slice(0, 4),
    question: topic.trim(),
    difficulty: DISCOVER_DIFFICULTY,
    ...(recent ? { prioritize: 'recency' as const } : {}),
  };
}

/* ---- discover_papers output ---------------------------------------------
   One numbered entry per paper, every field after the id optional in practice:
   `1. [ID=2406.09246] **Title** (https://www.alphaxiv.org/abs/2406.09246).
   Published 2024-09-04 by Org, Org · 458 votes · 32655 views: Abstract…` */

export interface DiscoveredPaper {
  /** Bare arXiv id ('2406.09246', 'hep-th/9901001'); '' when the entry had none */
  id: string;
  title: string;
  /** Where to open the paper — the entry's link, or the alphaXiv page for its id */
  url: string;
  /** As sent, YYYY-MM-DD; '' when absent */
  published: string;
  /** The "by …" segment — authors or affiliations, whichever alphaXiv listed */
  authors: string;
  votes: number | null;
  abstract: string;
}

/** Bounds one session-stored turn; alphaXiv returns ~15 for a normal search. */
const MAX_DISCOVERED = 20;
const ABSTRACT_CHARS = 220;
/** How many titles the text form names before summarizing the rest. */
const NAMED_IN_TEXT = 5;

const ENTRY_RE = /(?:^|\s)\d+\.\s*\[ID=([^\]]*)\]\s*([\s\S]*?)(?=\s\d+\.\s*\[ID=|$)/g;

function clip(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars).trimEnd()}…` : collapsed;
}

/** Bold when alphaXiv styled it; otherwise whatever precedes the link or date. */
function titleOf(body: string): string {
  const bold = body.match(/\*\*([\s\S]+?)\*\*/);
  const raw = bold ? bold[1] : body.split(/\(https?:|\.\s*Published\b/)[0];
  return clip(raw.replace(/[*`]/g, ''), 300);
}

/**
 * Structure a `discover_papers` response. An empty array means the response
 * wasn't in the documented shape — callers fall back to the raw text, same as
 * `parsePagesXml` does, so a wording change on alphaXiv's side degrades rather
 * than breaks.
 */
export function parseDiscoveredPapers(raw: string): DiscoveredPaper[] {
  const papers: DiscoveredPaper[] = [];
  ENTRY_RE.lastIndex = 0;
  for (let m = ENTRY_RE.exec(raw); m !== null; m = ENTRY_RE.exec(raw)) {
    const id = m[1].trim();
    const body = m[2];
    const title = titleOf(body);
    if (!title) continue;

    // The meta block ends at "…views:" / "…votes:" — everything after is abstract
    const cut = body.match(/\b(?:views?|votes?)\s*:\s+/);
    const votes = body.match(/([\d,]+)\s+votes?\b/);
    papers.push({
      id,
      title,
      url: body.match(/\((https?:\/\/[^\s)]+)\)/)?.[1] ?? (id ? `https://www.alphaxiv.org/abs/${id}` : ''),
      published: body.match(/Published\s+(\d{4}-\d{2}-\d{2})/)?.[1] ?? '',
      // Anchored to the Published clause and stopped at the next separator so a
      // stray "by" inside the abstract can't be mistaken for the byline
      authors: clip(body.match(/Published[^·:]*?\bby\s+([^·:]+)/)?.[1] ?? '', 160),
      votes: votes ? Number(votes[1].replace(/,/g, '')) : null,
      abstract: cut ? clip(body.slice(cut.index! + cut[0].length), ABSTRACT_CHARS) : '',
    });
    if (papers.length === MAX_DISCOVERED) break;
  }
  return papers;
}

/**
 * The text form of a search, for the surfaces with no card UI: the command
 * palette, plan transcripts, spoken replies, and the assistant's own history of
 * the conversation. Names a few papers with their ids — enough for a follow-up
 * ("save the second one") to resolve — and counts the rest.
 */
export function formatDiscoveredPapers(papers: DiscoveredPaper[], topic: string): string {
  const named = papers.slice(0, NAMED_IN_TEXT);
  const rest = papers.length - named.length;
  return [
    `${papers.length} paper${papers.length === 1 ? '' : 's'} on “${topic.trim()}”:`,
    ...named.map((p, i) => `${i + 1}. ${p.title}${p.id ? ` (${p.id})` : ''}`),
    ...(rest > 0 ? [`…and ${rest} more.`] : []),
  ].join('\n');
}

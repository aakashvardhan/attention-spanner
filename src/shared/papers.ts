import { FETCH_TIMEOUT_MS, SEMANTIC_SCHOLAR_PAPER_API } from './constants';
import type { Paper } from './types';

/** Metadata fields a lookup can fill; the rest of a Paper is user-supplied. */
export type PaperMeta = Pick<
  Paper,
  'title' | 'authors' | 'venue' | 'year' | 'citations' | 'abstract'
> & { url: string };

/** Result of a lookup — a specific message on failure so the user can act on it. */
export type FetchMetaResult = { ok: true; meta: PaperMeta } | { ok: false; message: string };

/**
 * Turn a pasted reference into the Semantic Scholar path segment.
 * Recognizes arXiv ids (new `2006.11239` and legacy `hep-th/9901001` styles,
 * with or without an arxiv.org URL wrapper) and DOIs; otherwise falls back to a
 * raw URL lookup. Returns null when there's nothing usable to look up.
 */
export function parsePaperRef(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // arXiv: bare id, or inside an arxiv.org/abs|pdf URL. Strip a trailing
  // version and a `.pdf` suffix so abs/pdf/versioned links all resolve alike.
  const arxivUrl = raw.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i);
  const candidate = (arxivUrl ? arxivUrl[1] : raw).replace(/\.pdf$/i, '');
  const newStyle = candidate.match(/^(\d{4}\.\d{4,5})(v\d+)?$/i);
  const oldStyle = candidate.match(/^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i);
  if (newStyle) return `arXiv:${newStyle[1]}`;
  if (oldStyle) return `arXiv:${oldStyle[1]}`;

  // DOI: bare, or inside a doi.org URL.
  const doi = raw.match(/(10\.\d{4,9}\/[^\s?#]+)/i);
  if (doi) return `DOI:${doi[1]}`;

  // Anything else that looks like a link → URL lookup.
  if (/^https?:\/\//i.test(raw)) return `URL:${raw}`;
  return null;
}

/**
 * A stable key for matching an open tab's URL to a stored paper. arXiv ids and
 * DOIs collapse the abs/pdf/versioned/publisher variants together; other links
 * fall back to a host+path normalization (protocol, `www.`, query, hash, and a
 * trailing slash are ignored). Returns null when there's nothing to match on.
 */
export function paperMatchKey(url: string): string | null {
  const ref = parsePaperRef(url);
  if (!ref) return null;
  if (!ref.startsWith('URL:')) return ref.toLowerCase(); // arXiv:… / DOI:…
  try {
    const u = new URL(url);
    return `url:${u.host.replace(/^www\./i, '')}${u.pathname.replace(/\/$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
}

interface S2Response {
  title?: string | null;
  abstract?: string | null;
  venue?: string | null;
  year?: number | null;
  citationCount?: number | null;
  authors?: { name: string }[] | null;
}

/**
 * Look up paper metadata from Semantic Scholar. Returns a specific message on
 * failure so the user can act (bad key vs. rate limit vs. not found) and always
 * has manual entry as a fallback. Safe to call directly from an extension page —
 * a plain GET is CORS-allowed and a custom `x-api-key` header still reaches S2
 * (verified: it returns 403 for a bad key rather than being CORS-blocked).
 */
export async function fetchPaperMeta(input: string, apiKey = ''): Promise<FetchMetaResult> {
  const ref = parsePaperRef(input);
  if (!ref) {
    return {
      ok: false,
      message: "That doesn't look like an arXiv ID, DOI, or paper URL — enter the details manually.",
    };
  }

  const fields = 'title,authors,venue,year,citationCount,abstract';
  // Keep the `arXiv:`/`DOI:` prefix colon literal (Semantic Scholar matches it in
  // the path); only a raw URL ref needs its reserved characters encoded.
  const pathRef = ref.startsWith('URL:') ? `URL:${encodeURIComponent(ref.slice(4))}` : ref;
  const url = `${SEMANTIC_SCHOLAR_PAPER_API}${pathRef}?fields=${fields}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // An API key lifts the aggressive unauthenticated rate limit
      headers: apiKey ? { 'x-api-key': apiKey } : undefined,
    });
    if (!res.ok) {
      let message: string;
      if (res.status === 401 || res.status === 403) {
        message = apiKey
          ? 'Semantic Scholar rejected the API key (403). Check it in Settings — new keys can take a while to activate.'
          : 'Semantic Scholar refused the request (403). Add an API key in Settings.';
      } else if (res.status === 429) {
        message = apiKey
          ? 'Still rate-limited (429) — the key may not be active yet. Wait a minute and retry.'
          : 'Rate-limited (429). Add a Semantic Scholar API key in Settings, or wait a minute and retry.';
      } else if (res.status === 404) {
        message = 'No record found for that reference — enter the details manually.';
      } else {
        message = `Semantic Scholar returned an error (${res.status}) — enter the details manually.`;
      }
      return { ok: false, message };
    }
    const data = (await res.json()) as S2Response;
    return {
      ok: true,
      meta: {
        title: data.title ?? '',
        authors: (data.authors ?? []).map((a) => a.name).join(', '),
        venue: data.venue ?? '',
        year: data.year ?? null,
        citations: data.citationCount ?? null,
        abstract: data.abstract ?? '',
        // Prefer a canonical arXiv abstract link; else echo what the user pasted.
        url: ref.startsWith('arXiv:')
          ? `https://arxiv.org/abs/${ref.slice('arXiv:'.length)}`
          : input.trim(),
      },
    };
  } catch {
    return {
      ok: false,
      message: "Couldn't reach Semantic Scholar — check your connection, then enter details manually.",
    };
  } finally {
    clearTimeout(timer);
  }
}

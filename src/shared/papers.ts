
/**
 * Turn a pasted reference into a typed key (arXiv:/DOI:/URL:).
 * Recognizes arXiv ids (new `2006.11239` and legacy `hep-th/9901001` styles,
 * with or without an arxiv.org URL wrapper) and DOIs; otherwise falls back to a
 * raw URL lookup. Returns null when there's nothing usable to look up.
 */
export function parsePaperRef(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // arXiv: bare id, or inside an arxiv.org/abs|pdf URL or an alphaxiv.org
  // abs|overview|pdf URL (alphaXiv pages are keyed by arXiv id). Strip a trailing
  // version and a `.pdf` suffix so abs/pdf/versioned links all resolve alike.
  const arxivUrl = raw.match(/(?:arxiv|alphaxiv)\.org\/(?:abs|pdf|overview)\/([^\s?#]+)/i);
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

/** The bare arXiv id in a link or id, or null when it is not arXiv. */
export function arxivId(input: string): string | null {
  const ref = parsePaperRef(input);
  return ref?.startsWith('arXiv:') ? ref.slice('arXiv:'.length) : null;
}

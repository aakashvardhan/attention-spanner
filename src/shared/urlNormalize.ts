/**
 * Canonical key for article identity: matches feed-item links against tab URLs
 * even when they differ by scheme, www, hash, tracking params, or trailing slash.
 * The scheme is dropped entirely so http and https collapse to the same key.
 */

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ref|ref_src|source|cmpid|s_kwcid|igshid)$/i;

export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim().toLowerCase();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return raw.trim();
  }

  const host = u.hostname.toLowerCase().replace(/^www\./, '');

  const params = [...u.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = params.length
    ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : '';

  const path = u.pathname.replace(/\/+$/, '') || '/';

  return `${host}${path}${query}`;
}

import { PAGE_TEXT_MAX_CHARS } from '../constants';

/**
 * Grab readable text from the active tab for page-aware help ("summarize
 * this"). Uses chrome.scripting func injection — no readability dependency,
 * <article>/<main> preferred, chrome-y URLs skipped. Callable from any
 * extension page (popup is the natural surface; on the newtab the "active
 * tab" is the newtab itself, which returns null).
 */

export interface PageContent {
  title: string;
  url: string;
  text: string;
}

function isReadableUrl(url: string | undefined): url is string {
  if (!url) return false;
  return (
    /^https?:\/\//i.test(url) &&
    !url.startsWith('https://chromewebstore.google.com') &&
    !url.startsWith('https://chrome.google.com/webstore')
  );
}

/** Runs inside the page via executeScript — must be self-contained */
function extractPageText(): { title: string; text: string } {
  const root =
    document.querySelector('article') ?? document.querySelector('main') ?? document.body;
  const clone = root.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll('nav, header, footer, aside, script, style, noscript, iframe, form, button')) {
    el.remove();
  }
  const text = (clone.textContent ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: document.title, text };
}

export async function getActivePageContent(
  maxChars = PAGE_TEXT_MAX_CHARS,
): Promise<PageContent | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !isReadableUrl(tab.url)) return null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageText,
    });
    const extracted = result?.result;
    if (!extracted || extracted.text.length < 80) return null;
    return { title: extracted.title, url: tab.url, text: extracted.text.slice(0, maxChars) };
  } catch {
    return null; // page blocked injection (CSP, PDF viewer, …)
  }
}

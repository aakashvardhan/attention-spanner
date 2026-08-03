import { PAGE_TEXT_MAX_CHARS } from '../constants';
import { articleText, extractArticle } from '../articleExtract';

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
  try {
    // Match useActiveTab(), which owns the side-panel header. lastFocusedWindow
    // can point at a different Chrome window after the panel or DevTools takes
    // focus, making the header and the assistant silently target different tabs.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isReadableUrl(tab.url)) return null;

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractPageText,
    });
    const extracted = result?.result;
    if (extracted && extracted.text.length >= 80) {
      return { title: extracted.title, url: tab.url, text: extracted.text.slice(0, maxChars) };
    }

    return await fetchPageContent(tab.url, tab.title ?? '', maxChars);
  } catch {
    // Injection can fail during navigation or on a browser-protected document.
    // Query the same tab again and try the public HTML before giving up.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab && isReadableUrl(tab.url)
        ? await fetchPageContent(tab.url, tab.title ?? '', maxChars)
        : null;
    } catch {
      return null;
    }
  }
}

/**
 * Host permissions let an extension page fetch public article HTML even when
 * the live DOM cannot be scripted. DOMParser is absent in the service worker,
 * where this helper simply declines and leaves the caller's screenshot path
 * intact.
 */
async function fetchPageContent(
  url: string,
  fallbackTitle: string,
  maxChars: number,
): Promise<PageContent | null> {
  if (typeof DOMParser === 'undefined') return null;
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) return null;
  const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
  const extracted = extractArticle(doc, fallbackTitle);
  const text = articleText(extracted.blocks);
  if (text.length < 80) return null;
  return { title: extracted.title || fallbackTitle, url, text: text.slice(0, maxChars) };
}

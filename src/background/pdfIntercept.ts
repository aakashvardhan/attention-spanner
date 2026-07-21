import { isPdfUrl, readerPageUrl, shouldInterceptPdf } from '../shared/pdf';
import { getSession, setSession } from '../shared/storage';

/*
 * Sends PDF navigations into the in-extension reader (src/pages/reader/), the
 * way Google Scholar PDF Reader does. The reader's "Open in Chrome's viewer"
 * button records the URL in a session-scoped bypass list so redirecting back
 * to the native viewer (and reloading it) doesn't bounce into the reader again.
 */

/** Called from tabs.onUpdated with every navigation URL. */
export async function maybeInterceptPdf(tabId: number, url: string): Promise<void> {
  if (!isPdfUrl(url)) return; // cheap check before touching session storage
  const { pdfNativeBypass } = await getSession('pdfNativeBypass');
  if (!shouldInterceptPdf(url, pdfNativeBypass)) return;
  try {
    await chrome.tabs.update(tabId, { url: readerPageUrl(url) });
  } catch {
    // Tab closed mid-navigation — nothing to redirect.
  }
}

/** Reader → native viewer: remember the choice for the session, then navigate. */
export async function openNativePdf(tabId: number, url: string): Promise<{ ok: boolean }> {
  const { pdfNativeBypass } = await getSession('pdfNativeBypass');
  if (!pdfNativeBypass.includes(url)) {
    await setSession({ pdfNativeBypass: [...pdfNativeBypass, url] });
  }
  await chrome.tabs.update(tabId, { url });
  return { ok: true };
}

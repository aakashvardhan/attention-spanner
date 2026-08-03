import { MAX_PDF_NATIVE_BYPASS } from '../shared/constants';
import { isPdfResponse, isPdfUrl, readerPageUrl, shouldInterceptPdf } from '../shared/pdf';
import { getSession, setSession } from '../shared/storage';

/*
 * Sends PDF navigations into the in-extension reader (src/pages/reader/), the
 * way Google Scholar PDF Reader does. Two paths, because a PDF isn't always
 * knowable from its URL: the cheap URL match below, and the response-header
 * match that catches extensionless PDFs. The reader's "Open in Chrome's viewer"
 * button records the URL in a session-scoped bypass list so redirecting back
 * to the native viewer (and reloading it) doesn't bounce into the reader again.
 */

/** Called from tabs.onUpdated with every navigation URL. */
export async function maybeInterceptPdf(tabId: number, url: string): Promise<void> {
  if (!isPdfUrl(url)) return; // cheap check before touching session storage
  const { pdfNativeBypass } = await getSession('pdfNativeBypass');
  if (!shouldInterceptPdf(url, pdfNativeBypass)) return;
  await redirectToReader(tabId, url);
}

/** Header value lookup — webRequest header names arrive in arbitrary casing. */
function header(headers: chrome.webRequest.HttpHeader[], name: string): string | null {
  return headers.find((h) => h.name.toLowerCase() === name)?.value ?? null;
}

/**
 * Called from webRequest.onHeadersReceived for top-level navigations. Handles
 * only what the URL can't reveal — a URL that already looks like a PDF was
 * redirected by `maybeInterceptPdf`, and letting both fire would redirect the
 * tab twice.
 */
export async function maybeInterceptPdfResponse(
  details: chrome.webRequest.WebResponseHeadersDetails,
): Promise<void> {
  if (details.tabId < 0 || isPdfUrl(details.url)) return;
  const headers = details.responseHeaders ?? [];
  if (!isPdfResponse(header(headers, 'content-type'), header(headers, 'content-disposition'))) {
    return;
  }
  const { pdfNativeBypass } = await getSession('pdfNativeBypass');
  if (pdfNativeBypass.includes(details.url)) return;
  await redirectToReader(details.tabId, details.url);
}

async function redirectToReader(tabId: number, url: string): Promise<void> {
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
    // Capped like every other stored list: this only clears on browser restart,
    // and the oldest bypass is the one least likely to be revisited.
    await setSession({
      pdfNativeBypass: [...pdfNativeBypass, url].slice(-MAX_PDF_NATIVE_BYPASS),
    });
  }
  await chrome.tabs.update(tabId, { url });
  return { ok: true };
}

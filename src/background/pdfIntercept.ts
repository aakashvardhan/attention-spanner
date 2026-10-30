import { MAX_PDF_NATIVE_BYPASS, PDF_BYPASS_DNR_ID_BASE, PDF_DNR_ID, READER_PAGE_PATH } from '../shared/constants';
import { isLocalPdfUrl, readerPageUrl } from '../shared/pdf';
import { getSession, setSession } from '../shared/storage';

/*
 * Sends PDF navigations into the in-extension reader (src/pages/reader/), the
 * way Google Scholar PDF Reader does. A declarativeNetRequest session rule
 * matches the response's Content-Type, so the redirect happens in the network
 * stack before Chrome's own viewer ever paints — no flash of the native viewer
 * and no second load, which the old tabs.onUpdated redirect could not avoid.
 * It also catches extensionless PDFs (allenai.org/papers/…) for free.
 *
 * The reader's "Open in Chrome's viewer" button records the URL in a
 * session-scoped bypass list, mirrored as higher-priority allow rules, so
 * redirecting back to the native viewer (and reloading it) doesn't bounce into
 * the reader again. Focus redirects (priority 300) still win over both.
 */

const PDF_PRIORITY = 1;

function readerRedirectRule(): chrome.declarativeNetRequest.Rule {
  return {
    id: PDF_DNR_ID,
    priority: PDF_PRIORITY,
    action: {
      type: 'redirect' as chrome.declarativeNetRequest.RuleActionType,
      // \0 is the raw URL, unencoded; the reader reads ?raw= as everything after it.
      redirect: { regexSubstitution: `${chrome.runtime.getURL(READER_PAGE_PATH)}?raw=\\0` },
    },
    condition: {
      regexFilter: '^https?://.*',
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
      responseHeaders: [{ header: 'content-type', values: ['application/pdf', 'application/pdf;*'] }],
      // An attachment is a download, not a page: the tab stays where it is.
      excludedResponseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
    },
  };
}

function bypassRule(url: string, i: number): chrome.declarativeNetRequest.Rule {
  return {
    id: PDF_BYPASS_DNR_ID_BASE + i,
    priority: PDF_PRIORITY + 1,
    action: { type: 'allow' as chrome.declarativeNetRequest.RuleActionType },
    // ponytail: urlFilter treats * ^ | as syntax, so a URL containing them
    // won't match and bounces into the reader; escape-free regexFilter if it bites.
    condition: {
      urlFilter: `|${url}|`,
      resourceTypes: ['main_frame' as chrome.declarativeNetRequest.ResourceType],
    },
  };
}

function isPdfRule(id: number): boolean {
  return id >= PDF_DNR_ID && id < PDF_BYPASS_DNR_ID_BASE + MAX_PDF_NATIVE_BYPASS;
}

/**
 * Rebuild the redirect and bypass rules in one atomic update. Called on every
 * worker start (session rules outlive the worker, and this keeps them in step
 * with the bypass list) and after each bypass.
 */
export async function syncPdfRules(): Promise<void> {
  const [{ pdfNativeBypass }, existing] = await Promise.all([
    getSession('pdfNativeBypass'),
    chrome.declarativeNetRequest.getSessionRules(),
  ]);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((r) => r.id).filter(isPdfRule),
    addRules: [readerRedirectRule(), ...pdfNativeBypass.map(bypassRule)],
  });
}

/**
 * Called from tabs.onUpdated with every navigation URL. DNR does not see
 * file:// navigations, so a local PDF is still redirected after the fact.
 */
export async function maybeInterceptPdf(tabId: number, url: string): Promise<void> {
  if (!isLocalPdfUrl(url)) return;
  // A local file is readable only with "Allow access to file URLs" on in
  // chrome://extensions; without it the reader would fail, so Chrome's viewer keeps it.
  if (!(await chrome.extension.isAllowedFileSchemeAccess())) return;
  const { pdfNativeBypass } = await getSession('pdfNativeBypass');
  if (pdfNativeBypass.includes(url)) return;
  try {
    await chrome.tabs.update(tabId, { url: readerPageUrl(url) });
  } catch {
    // Tab closed mid-navigation — nothing to redirect.
  }
}

/** Reader → native viewer: remember the choice for the session, then navigate. */
export async function openNativePdf(tabId: number, url: string): Promise<{ ok: boolean }> {
  await bypassPdfReader(url);
  await chrome.tabs.update(tabId, { url });
  return { ok: true };
}

/** Keep the interceptors off this URL for the rest of the session. */
export async function bypassPdfReader(url: string): Promise<void> {
  const { pdfNativeBypass } = await getSession('pdfNativeBypass');
  if (!pdfNativeBypass.includes(url)) {
    // Capped like every other stored list: this only clears on browser restart,
    // and the oldest bypass is the one least likely to be revisited.
    await setSession({
      pdfNativeBypass: [...pdfNativeBypass, url].slice(-MAX_PDF_NATIVE_BYPASS),
    });
  }
  await syncPdfRules();
}

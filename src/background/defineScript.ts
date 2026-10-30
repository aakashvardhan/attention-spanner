/*
 * Option/Alt-click to define a word, on every web page (src/content/define.ts).
 * Registered once for future pages; injected into the tabs already open, which
 * registration never reaches.
 */

const DEFINE_ID = 'define-on-alt-click';
const MATCHES = ['http://*/*', 'https://*/*'];

/** Idempotent under concurrency, like registerTimedtextTee: a duplicate id means it is registered. */
export async function registerDefineScript(): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DEFINE_ID] });
  if (existing.length > 0) return;
  try {
    await chrome.scripting.registerContentScripts([
      { id: DEFINE_ID, matches: MATCHES, js: ['content/define.js'], runAt: 'document_idle' },
    ]);
  } catch (error) {
    if (!(error instanceof Error && /duplicate script id/i.test(error.message))) throw error;
  }
}

export async function injectDefineScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/define.js'] });
  } catch {
    // Restricted page (Web Store, chrome://, the PDF viewer): nothing to define there.
  }
}

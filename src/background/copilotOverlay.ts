/**
 * Summons the floating overlay into a tab. Injection is the toggle: the content
 * script closes itself when re-run (see __readerCopilotToggle), so this side
 * needs no idea of which tabs currently have one — which is the only version of
 * this that survives the service worker being torn down between presses.
 *
 * Unlike the time pill this is never injected automatically. An assistant panel
 * that appears on pages you did not ask it on is the opposite of what this
 * extension is for.
 */
export async function toggleCopilotOverlay(tabId: number, url: string): Promise<void> {
  // chrome:// pages, the newtab and the Web Store reject injection outright.
  if (!/^https?:/i.test(url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/copilotOverlay.js'],
    });
  } catch (error) {
    console.error('[overlay] could not inject', error);
  }
}

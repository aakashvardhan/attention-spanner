import { NEWTAB_PAGE_PATH, OFFSCREEN_PAGE_PATH } from '../shared/constants';
import { getSession, setSession } from '../shared/storage';

/**
 * Lifecycle of the offscreen document. Chrome allows one per extension, so all
 * creation funnels through here. The recorder is currently the only holder, but
 * the reference counting stays: it is what makes adding a second consumer safe,
 * and the wake word that used to be the second one proved the case.
 */

export type OffscreenHolder = 'recorder';

/** Collapses concurrent createDocument calls into one (the API throws on a second) */
let creating: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PAGE_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Recording lecture and meeting audio for transcription',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/** Create the document if needed and register `holder` as needing it alive. */
export async function acquireOffscreen(holder: OffscreenHolder): Promise<void> {
  const { offscreenHolders } = await getSession('offscreenHolders');
  if (!offscreenHolders.includes(holder)) {
    await setSession({ offscreenHolders: [...offscreenHolders, holder] });
  }
  await ensureOffscreenDocument();
}

/** Drop `holder`; the document closes only once nothing needs it. */
export async function releaseOffscreen(holder: OffscreenHolder): Promise<void> {
  const { offscreenHolders } = await getSession('offscreenHolders');
  const remaining = offscreenHolders.filter((h) => h !== holder);
  await setSession({ offscreenHolders: remaining });
  if (remaining.length === 0 && (await hasOffscreenDocument())) {
    await chrome.offscreen.closeDocument();
  }
}

/** Focus an existing dashboard tab; open one only when none exists */
export async function openDashboard(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL(NEWTAB_PAGE_PATH) });
  const tab = tabs[0];
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: chrome.runtime.getURL(NEWTAB_PAGE_PATH) });
  }
}


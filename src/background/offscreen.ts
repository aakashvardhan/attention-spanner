import { NEWTAB_PAGE_PATH, NOTIFICATION_IDS, OFFSCREEN_PAGE_PATH } from '../shared/constants';
import { getSettings } from '../shared/storage';

/**
 * Lifecycle of the wake-word offscreen document. Chrome allows one offscreen
 * document per extension, so all creation funnels through here — if another
 * feature ever needs one, its reason gets merged into this createDocument.
 */

/** Collapses concurrent createDocument calls into one (the API throws on a second) */
let creating: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PAGE_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Always-on "Hey Jarvis" wake-word listening for the voice assistant',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export async function closeOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
}

/** Reconcile the offscreen doc with settings (startup, install, settings change) */
export async function syncWakeWordListener(): Promise<void> {
  const settings = await getSettings();
  if (settings.assistantEnabled && settings.assistantWakeWordEnabled) {
    await ensureOffscreenDocument();
  } else {
    await closeOffscreenDocument();
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

/** Handle a WAKE_EVENT from the offscreen listener */
export async function handleWakeEvent(
  event: 'replied' | 'needs-ui' | 'handoff' | 'mic-denied',
  text?: string,
): Promise<void> {
  const settings = await getSettings();
  const notify = (id: string, message: string) => {
    if (!settings.notificationsEnabled) return;
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: 'Jarvis',
      message,
    });
  };

  switch (event) {
    case 'replied':
      notify(NOTIFICATION_IDS.wakeReply, text ?? 'Done.');
      break;
    case 'needs-ui':
      notify(NOTIFICATION_IDS.wakeReply, text ?? 'I need a confirmation on the dashboard.');
      await openDashboard();
      break;
    case 'handoff':
      await openDashboard();
      break;
    case 'mic-denied':
      notify(NOTIFICATION_IDS.wakeMicDenied, 'Microphone blocked — fix it in Settings → Assistant.');
      break;
  }
}

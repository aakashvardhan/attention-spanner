import { NEWTAB_PAGE_PATH, NOTIFICATION_IDS, OFFSCREEN_PAGE_PATH } from '../shared/constants';
import { broadcastMessage } from '../shared/messages';
import { getSession, getSettings, setSession } from '../shared/storage';

/**
 * Lifecycle of the offscreen document. Chrome allows one per extension, so all
 * creation funnels through here. Two features need it — the "Hey Jarvis" wake
 * word and the audio recorder — so neither may close it on its own: holders are
 * reference-counted, and the document only goes away once the last one lets go.
 * Otherwise turning the wake word off mid-recording would pull the recording's
 * document out from under a recording in progress.
 */

export type OffscreenHolder = 'wake' | 'recorder';

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
      // One reason covers both holders: the wake word and the recorder are each
      // a getUserMedia consumer.
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification:
        '"Hey Jarvis" wake-word listening, and recording lecture/meeting audio for transcription',
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

/**
 * Reconcile the wake-word listener with settings (startup, install, settings
 * change). Turning the wake word off stops the listener but leaves the document
 * standing when the recorder still holds it — closing it would kill a recording
 * that has nothing to do with the setting the user just changed.
 */
export async function syncWakeWordListener(): Promise<void> {
  const settings = await getSettings();
  const enabled = settings.assistantEnabled && settings.assistantWakeWordEnabled;
  if (enabled) {
    // Logged because createDocument failing here is otherwise invisible: every
    // caller invokes this with `void`, so the rejection goes nowhere.
    await acquireOffscreen('wake');
    console.log('[wake] offscreen document acquired');
  }
  // The document may already exist for the recorder; tell the listener inside it
  // which way to go before any release can close it.
  await broadcastMessage({ type: 'WAKE_LISTENER_SET', enabled });
  if (!enabled) {
    await releaseOffscreen('wake');
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

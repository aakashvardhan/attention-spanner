import type { Message } from '../../shared/messages';
import { WakeListener } from './wakeListener';

/**
 * Offscreen document entry (chrome.offscreen, reason USER_MEDIA). Exists only
 * while the "Hey Jarvis" wake word is enabled — the service worker creates and
 * closes it from syncWakeWordListener().
 */

const listener = new WakeListener();
listener.start();

chrome.runtime.onMessage.addListener((msg: Message) => {
  // Push-to-talk elsewhere holds the mic; never sendResponse — the SW router
  // owns the reply channel for every message type.
  if (msg.type === 'WAKE_MIC_BUSY') listener.setPaused(msg.busy);
});

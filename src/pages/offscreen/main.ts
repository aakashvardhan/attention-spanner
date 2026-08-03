import { detectCapabilities } from '../../shared/capabilities';
import type { Message } from '../../shared/messages';
import { getSettings } from '../../shared/storage';
import { Recorder } from './recorder';
import { WakeListener } from './wakeListener';

/**
 * Offscreen document entry (chrome.offscreen, reason USER_MEDIA). Shared by two
 * features — the "Hey Jarvis" wake word and the audio recorder — so neither
 * owns the document: src/background/offscreen.ts reference-counts it.
 *
 * Because the recorder can be what brought the document into existence, the
 * wake listener must NOT start unconditionally. Doing so would switch on an
 * always-on microphone the user never enabled, purely as a side effect of
 * hitting record.
 */

let listener: WakeListener | null = null;

function setWakeListener(enabled: boolean): void {
  if (enabled && !listener) {
    console.log('[wake] starting listener');
    listener = new WakeListener();
    listener.start();
  } else if (!enabled && listener) {
    console.log('[wake] stopping listener');
    listener.stop();
    listener = null;
  }
}

// One line, once, naming both halves of "is the wake word going to work here":
// what the user asked for, and what this browser can actually deliver. Brave
// removes webkitSpeechRecognition entirely, and without this the listener just
// returned at the top of spinUp() with nothing said about why.
void getSettings()
  .then((s) => {
    const wanted = s.assistantEnabled && s.assistantWakeWordEnabled;
    console.log('[wake] boot', { wanted, ...detectCapabilities() });
    setWakeListener(wanted);
  })
  .catch((error) => console.error('[wake] could not read settings on boot', error));

const recorder = new Recorder();

chrome.runtime.onMessage.addListener((msg: Message) => {
  // Never sendResponse — the SW router owns the reply channel for every message
  // type, including the ones addressed here.
  if (msg.type === 'WAKE_MIC_BUSY') listener?.setPaused(msg.busy);
  else if (msg.type === 'WAKE_LISTENER_SET') setWakeListener(msg.enabled);
  else if (msg.type === 'REC_BEGIN') {
    void recorder.begin(msg.id, msg.mode, msg.streamId, {
      visualCapture: msg.visualCapture,
      title: msg.title,
      purpose: msg.purpose,
    });
  } else if (msg.type === 'REC_GRAB_FRAME') recorder.grabFrame();
  else if (msg.type === 'REC_STOP') recorder.stop();
});

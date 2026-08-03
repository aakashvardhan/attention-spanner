import type { Message } from '../../shared/messages';
import { Recorder } from './recorder';

/**
 * Offscreen document entry (chrome.offscreen, reason USER_MEDIA). The recorder
 * is now its only consumer — the "Hey Jarvis" wake word used to share it — but
 * src/background/offscreen.ts still reference-counts the document rather than
 * letting the recorder own it outright, because a second holder is exactly the
 * kind of thing that gets added back without revisiting the lifecycle.
 */

const recorder = new Recorder();

chrome.runtime.onMessage.addListener((msg: Message) => {
  // Never sendResponse — the SW router owns the reply channel for every message
  // type, including the ones addressed here.
  if (msg.type === 'REC_BEGIN') {
    void recorder.begin(msg.id, msg.mode, msg.streamId, {
      visualCapture: msg.visualCapture,
      title: msg.title,
      purpose: msg.purpose,
    });
  } else if (msg.type === 'REC_GRAB_FRAME') recorder.grabFrame();
  else if (msg.type === 'REC_STOP') recorder.stop();
});

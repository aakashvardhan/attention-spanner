import { SCREENSHOT_MAX_WIDTH } from '../constants';
import { getSettings } from '../storage';

/**
 * One-shot page vision for the assistant: what the active tab looks like,
 * as a downscaled JPEG ready for a Gemini `images` part. Runs in extension
 * pages — captureVisibleTab works there directly (host permission already
 * covers it), and the page is also where the Gemini call happens, so the
 * image never crosses the message bus.
 *
 * Gated on assistantVisionEnabled here rather than at every call site, so a
 * switched-off toggle means no capture happens anywhere, full stop.
 */

export interface Screenshot {
  mimeType: string;
  dataBase64: string;
}

export async function getActiveTabScreenshot(): Promise<Screenshot | null> {
  try {
    if (!(await getSettings()).assistantVisionEnabled) return null;
    // Keep this aligned with useActiveTab() and getActivePageContent(): all
    // three side-panel features must operate on the tab beside the panel.
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // From the dashboard the active tab IS the dashboard — nothing to see.
    if (!tab?.url || !/^https?:/i.test(tab.url) || tab.windowId === undefined) return null;
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 70,
    });
    return await downscale(dataUrl);
  } catch {
    // No permission, minimized window, capture race — vision is an enhancement,
    // and the caller answers from text alone.
    return null;
  }
}

async function downscale(dataUrl: string): Promise<Screenshot | null> {
  const img = await loadImage(dataUrl);
  const scale = Math.min(1, SCREENSHOT_MAX_WIDTH / img.width);
  if (scale === 1) {
    const comma = dataUrl.indexOf(',');
    return comma === -1 ? null : { mimeType: 'image/jpeg', dataBase64: dataUrl.slice(comma + 1) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const scaled = canvas.toDataURL('image/jpeg', 0.7);
  const comma = scaled.indexOf(',');
  return comma === -1 ? null : { mimeType: 'image/jpeg', dataBase64: scaled.slice(comma + 1) };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('screenshot decode failed'));
    img.src = src;
  });
}

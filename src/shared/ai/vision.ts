import {
  VISION_DESC_MAX_CHARS,
  VISION_DESCRIBE_TIMEOUT_MS,
  VISION_DIFF_THRESHOLD,
  VISION_MIN_SEND_GAP_MS,
  VISION_SETTLE_THRESHOLD,
} from '../constants';
import { MAX_AUTO_VISUALS } from '../recordings';
import { newTurn } from './assistantTypes';
import { geminiProvider } from './geminiProvider';
import { stripEmoji } from './tts';

/**
 * Frame → description, for slides and shared screens captured during a tab
 * recording. The mirror of transcribe.ts, and Gemini-pinned for the same
 * reason: Nano has no image input and vision is not a provider preference
 * here but the only option. The frame never leaves the offscreen document —
 * only the description text crosses the message bus (REC_VISUAL_READY).
 *
 * The change-detection math lives here too, pure and unit-tested; the
 * offscreen frameWatcher owns the canvas and the clock, this file owns the
 * decisions.
 */

const NOTHING_NEW = 'NOTHING_NEW';

const DESCRIBE_SYSTEM =
  'You describe one frame captured from a screen recording — usually a slide, ' +
  'a shared screen, a diagram, or code. Transcribe the text that is visible, ' +
  'including headings, code and equations, and name what any diagram or chart ' +
  'shows. Describe only what is visibly present; never infer conclusions a ' +
  'chart or slide does not state, and never add information from your own ' +
  `knowledge. At most ${VISION_DESC_MAX_CHARS} characters of plain text — no ` +
  'markdown fences, no preamble, no emoji. If the frame adds nothing informative ' +
  `beyond the previous description, output exactly ${NOTHING_NEW}.`;

/** The instruction for one frame; recent speech anchors ambiguous visuals. Pure. */
export function buildDescribePrompt(transcriptTail: string, priorDescription: string): string {
  const parts = ['Describe this frame.'];
  if (priorDescription) {
    parts.push(`The previous frame was described as:\n"${priorDescription}"`);
  }
  if (transcriptTail) {
    parts.push(`For context only, the speaker recently said:\n"…${transcriptTail}"`);
  }
  return parts.join('\n\n');
}

/** Strip wrappers and map the nothing-new sentinel to ''. Pure. */
export function cleanDescription(raw: string): string {
  const text = stripEmoji(
    raw
      .trim()
      .replace(/^```(?:\w+)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim(),
  );
  if (text === '' || text.toUpperCase().includes(NOTHING_NEW)) return '';
  return text.slice(0, VISION_DESC_MAX_CHARS);
}

/**
 * Normalized mean absolute difference between two same-length grayscale grids
 * (0 = identical, 1 = black vs white). Pure. Grids of different lengths are
 * treated as fully different — a resize IS a scene change.
 */
export function frameDelta(a: Uint8ClampedArray | number[], b: Uint8ClampedArray | number[]): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}

export interface CaptureGate {
  /** Delta vs the last frame actually sent to Gemini (1 when none sent yet) */
  deltaVsSent: number;
  /** Delta vs the previous sample — the "still moving?" signal */
  deltaVsPrev: number;
  msSinceLastSend: number;
  autoCount: number;
}

/**
 * The settled-slide heuristic: changed since what we last described, no longer
 * changing frame-to-frame, not too soon, not over budget. Pure.
 */
export function shouldCapture(gate: CaptureGate): boolean {
  return (
    gate.deltaVsSent > VISION_DIFF_THRESHOLD &&
    gate.deltaVsPrev < VISION_SETTLE_THRESHOLD &&
    gate.msSinceLastSend >= VISION_MIN_SEND_GAP_MS &&
    gate.autoCount < MAX_AUTO_VISUALS
  );
}

/** Describe one frame. Returns '' when the frame held nothing new. */
export async function describeFrame(opts: {
  dataBase64: string;
  mimeType: string;
  /** Tail of the transcript so far — grounds "this chart" in what was said */
  transcriptTail?: string;
  /** The previous visual's description, so repeats collapse to NOTHING_NEW */
  priorDescription?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const reply = await geminiProvider.generate({
    system: DESCRIBE_SYSTEM,
    turns: [newTurn('user', buildDescribePrompt(opts.transcriptTail ?? '', opts.priorDescription ?? ''))],
    images: [{ mimeType: opts.mimeType, dataBase64: opts.dataBase64 }],
    signal: opts.signal ?? AbortSignal.timeout(VISION_DESCRIBE_TIMEOUT_MS),
  });
  return cleanDescription(reply.text);
}

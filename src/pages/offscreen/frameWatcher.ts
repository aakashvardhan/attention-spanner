import { describeFrame, frameDelta, shouldCapture } from '../../shared/ai/vision';
import {
  VISION_FRAME_JPEG_QUALITY,
  VISION_FRAME_MAX_WIDTH,
  VISION_FRAME_SAMPLE_MS,
  VISION_GRID_W,
  VISION_GRID_H,
} from '../../shared/constants';
import { sendMessage } from '../../shared/messages';
import { MAX_MANUAL_VISUALS } from '../../shared/recordings';

/**
 * Watches the video track of a tab capture for settled slides and shared
 * screens, and turns the ones worth keeping into descriptions
 * (REC_VISUAL_READY). Lives beside the Recorder in the offscreen document for
 * the same reason transcription does: the pixels are already here, and only
 * text should ever cross the message bus.
 *
 * The decisions (frameDelta, shouldCapture) are pure functions in
 * shared/ai/vision.ts; this class owns the canvas, the clock, and the caps.
 */
export class FrameWatcher {
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private prevGrid: Uint8ClampedArray | null = null;
  private sentGrid: Uint8ClampedArray | null = null;
  private lastSentAt = 0;
  private autoCount = 0;
  private manualCount = 0;
  private priorDescription = '';
  /** One describe call in flight at a time — a slow one must not queue more */
  private describing = false;
  private stopped = false;

  constructor(
    private readonly id: string,
    private readonly stream: MediaStream,
    private readonly startedAt: number,
    /** Recent transcript text, read at capture time — grounds the description */
    private readonly transcriptTail: () => string,
  ) {}

  async start(): Promise<void> {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = this.stream;
    this.video = video;
    await video.play().catch(() => undefined);
    this.timer = setInterval(() => this.sample(), VISION_FRAME_SAMPLE_MS);
  }

  /** Idempotent. The track itself is stopped by the Recorder's teardown. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    if (this.video) this.video.srcObject = null;
    this.video = null;
  }

  /** The user pressed Capture: skip the detector, keep the manual cap. */
  grabNow(): void {
    if (this.stopped || this.describing) return;
    if (this.manualCount >= MAX_MANUAL_VISUALS) return;
    const grid = this.readGrid();
    if (grid) void this.capture('manual', grid);
  }

  private sample(): void {
    if (this.stopped || this.describing) return;
    const grid = this.readGrid();
    if (!grid) return;
    const prev = this.prevGrid;
    this.prevGrid = grid;
    if (!prev) return;
    const gate = {
      deltaVsSent: this.sentGrid ? frameDelta(grid, this.sentGrid) : 1,
      deltaVsPrev: frameDelta(grid, prev),
      msSinceLastSend: this.lastSentAt ? Date.now() - this.lastSentAt : Infinity,
      autoCount: this.autoCount,
    };
    if (shouldCapture(gate)) void this.capture('auto', grid);
  }

  /** The postage-stamp grayscale grid the change detector compares. */
  private readGrid(): Uint8ClampedArray | null {
    const video = this.video;
    if (!video || video.readyState < 2 || video.videoWidth === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = VISION_GRID_W;
    canvas.height = VISION_GRID_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, VISION_GRID_W, VISION_GRID_H);
    const { data } = ctx.getImageData(0, 0, VISION_GRID_W, VISION_GRID_H);
    const luma = new Uint8ClampedArray(VISION_GRID_W * VISION_GRID_H);
    for (let i = 0; i < luma.length; i++) {
      const o = i * 4;
      luma[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    }
    return luma;
  }

  /** The full frame Gemini reads: downscaled, recompressed, base64 (no prefix). */
  private encodeFrame(): string | null {
    const video = this.video;
    if (!video || video.videoWidth === 0) return null;
    const scale = Math.min(1, VISION_FRAME_MAX_WIDTH / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', VISION_FRAME_JPEG_QUALITY);
    const comma = dataUrl.indexOf(',');
    return comma === -1 ? null : dataUrl.slice(comma + 1);
  }

  private async capture(kind: 'auto' | 'manual', grid: Uint8ClampedArray): Promise<void> {
    const frame = this.encodeFrame();
    if (!frame) return;
    const atSec = Math.max(0, Math.round((Date.now() - this.startedAt) / 1000));
    // Claim the slot before the network call: the sampler keeps ticking, and
    // an identical scene must not fire twice while Gemini thinks.
    this.sentGrid = grid;
    this.lastSentAt = Date.now();
    this.describing = true;
    try {
      const description = await describeFrame({
        dataBase64: frame,
        mimeType: 'image/jpeg',
        transcriptTail: this.transcriptTail(),
        priorDescription: this.priorDescription,
      });
      // '' = the model said NOTHING_NEW; the sent grid still updated, so the
      // scene won't be retried until it visibly changes again.
      if (!description || this.stopped) return;
      this.priorDescription = description;
      if (kind === 'auto') this.autoCount++;
      else this.manualCount++;
      await sendMessage({ type: 'REC_VISUAL_READY', id: this.id, atSec, kind, description });
    } catch (error) {
      // One failed frame must not sink the watcher — the next slide gets its chance.
      console.error('[frameWatcher] describe failed', error);
    } finally {
      this.describing = false;
    }
  }
}

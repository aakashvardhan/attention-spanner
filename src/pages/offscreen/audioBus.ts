import { micStream } from '../../shared/ai/audio';
import { WAKE_SAMPLE_RATE } from '../../shared/constants';

/**
 * The microphone, cut into fixed frames for the wake detector.
 *
 * One owner for the mic, deliberately. The detector, the command recorder and
 * any push-to-talk elsewhere all want the same device, and overlapping
 * getUserMedia sessions are what the WAKE_MIC_BUSY handshake already exists to
 * prevent. This holds the stream while the detector is listening and gives it
 * up the moment a command starts, so whatever transcribes that command has the
 * device to itself.
 *
 * The AudioContext is constructed at 16 kHz, which is what does the resampling:
 * the mic is typically 44.1 or 48 kHz and openWakeWord was trained at 16.
 */
export interface AudioBus {
  /** Resolves once frames are flowing. Throws if the mic is refused. */
  start(onFrame: (frame: Float32Array) => void): Promise<void>;
  stop(): void;
  /** The live stream, for a recorder that wants the same device. Null when stopped. */
  stream(): MediaStream | null;
  running(): boolean;
}

export function createAudioBus(): AudioBus {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;

  const stop = () => {
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
      node = null;
    }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void ctx?.close().catch(() => undefined);
    ctx = null;
  };

  return {
    stop,
    stream: () => stream,
    running: () => node !== null,
    async start(onFrame) {
      if (node) return;
      stream = await micStream();
      try {
        ctx = new AudioContext({ sampleRate: WAKE_SAMPLE_RATE });
        await ctx.audioWorklet.addModule(chrome.runtime.getURL('worklets/wake-tap.js'));
        const tap = new AudioWorkletNode(ctx, 'wake-tap');
        tap.port.onmessage = (e: MessageEvent<Float32Array>) => onFrame(e.data);
        ctx.createMediaStreamSource(stream).connect(tap);
        // Worklets with no downstream connection are not pulled in every
        // implementation; the destination is silent because the node emits
        // nothing, so this costs no audio output.
        tap.connect(ctx.destination);
        node = tap;
      } catch (error) {
        stop();
        throw error;
      }
    },
  };
}

/**
 * Cuts the microphone into the fixed-size frames the wake detector needs.
 *
 * The graph hands us 128 samples at a time; openWakeWord steps in 1280 (80 ms
 * at 16 kHz), which is exactly ten quanta. Buffering here rather than on the
 * other side of the port keeps partial frames off the message bus entirely.
 *
 * Plain JS in public/ on purpose: an AudioWorklet is loaded by URL as a
 * classic module into a separate global scope, so it cannot be part of the
 * TypeScript bundle that imports it.
 */
const FRAME = 1280;

class WakeTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FRAME);
    this.at = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input yet (or the track ended) — stay alive and wait for one
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buf[this.at++] = channel[i];
      if (this.at === FRAME) {
        // Transferred, not copied by structured clone: a new buffer each time
        // so the one in flight is never overwritten underneath the reader.
        const frame = this.buf.slice();
        this.port.postMessage(frame, [frame.buffer]);
        this.at = 0;
      }
    }
    return true;
  }
}

registerProcessor('wake-tap', WakeTap);

// The brain dump's mic tap: runs on the audio thread, batches the 128-sample
// render quanta into 480-sample (30 ms at 16 kHz) frames, and posts each one
// to the page, where Rust's VAD decides what is speech.
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(480);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.frame[this.filled++] = channel[i];
      if (this.filled === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(480);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('mic-tap', MicTap);

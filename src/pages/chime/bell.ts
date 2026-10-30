/**
 * The phase alarm: one gentle swell of singing-bowl strikes, about six
 * seconds, that stops on its own. Rising into a focus round, falling into a
 * break. Synthesised, so nothing is bundled. Takes any BaseAudioContext so it
 * can be rendered offline and measured.
 */
const NOTES = {
  focus: [392.0, 523.25, 659.25],
  break: [659.25, 523.25, 392.0],
};
/** A bowl's partials are not harmonic: [ratio, level, share of the decay time] */
const PARTIALS = [
  [1, 1, 1],
  [2.76, 0.35, 0.6],
  [5.4, 0.12, 0.35],
  [8.93, 0.05, 0.2],
] as const;
const STRIKE_GAP = 0.9;
/** Decay time constant of the fundamental: a bowl's tail, about -40dB after 5s */
const TAU = 1.3;
export const ALARM_SECONDS = 6.2;

export function ring(audio: BaseAudioContext, kind: 'focus' | 'break'): void {
  const t0 = audio.currentTime + 0.05;

  // The swell: fade in, hold, fade out, so even the first strike arrives softly.
  const master = audio.createGain();
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(1, t0 + 0.4);
  master.gain.setValueAtTime(1, t0 + ALARM_SECONDS - 1.5);
  master.gain.linearRampToValueAtTime(0, t0 + ALARM_SECONDS);
  master.connect(audio.destination);

  // Warmth: roll off the bright top, then a short synthetic room behind it.
  const tone = audio.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 2800;
  const room = audio.createConvolver();
  room.buffer = roomImpulse(audio, 2.5);
  const wet = audio.createGain();
  wet.gain.value = 0.3;
  tone.connect(master);
  tone.connect(room).connect(wet).connect(master);

  NOTES[kind].forEach((freq, i) => {
    const at = t0 + i * STRIKE_GAP;
    for (const [ratio, level, share] of PARTIALS) {
      // Two voices 3 cents apart beat slowly: the shimmer of a bowl.
      for (const detune of [0, 3]) {
        const gain = audio.createGain();
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.085 * level, at + 0.06);
        // A bell's decay is exponential toward silence; higher partials die sooner.
        gain.gain.setTargetAtTime(0.0001, at + 0.06, TAU * share);
        const osc = audio.createOscillator();
        osc.frequency.value = freq * ratio;
        osc.detune.value = detune;
        osc.connect(gain).connect(tone);
        osc.start(at);
        osc.stop(t0 + ALARM_SECONDS + 0.05);
      }
    }
  });
}

/** Decaying stereo noise: a small, soft room. */
function roomImpulse(audio: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.round(audio.sampleRate * seconds);
  const buffer = audio.createBuffer(2, length, audio.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  return buffer;
}

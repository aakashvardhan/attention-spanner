// The Pomodoro bell, played once on load. Three soft singing-bowl strikes:
// falling into a break, rising back into focus. Partials at bowl ratios.
const ctx = new AudioContext();
const notes = location.hash === '#break' ? [784, 659, 523] : [523, 659, 784];
notes.forEach((f, i) => {
  const t = ctx.currentTime + 0.1 + i * 0.9;
  for (const [ratio, peak] of [[1, 0.22], [2.76, 0.05], [5.4, 0.015]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = f * ratio;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 4.1);
  }
});

//! Has the speaker finished the thought, or only paused? The input side of
//! Smart Turn v3 (pipecat-ai/smart-turn, BSD-2-Clause): the audio it is shown
//! and the Whisper-style log-mel features it reads. The model itself runs in
//! the page (ext::smart_turn); this is the arithmetic, checked against the
//! reference numpy implementation.

use crate::voice::{speech_ranges, SAMPLE_RATE};

/// Quiet this long after speech and the model is asked whether the turn is
/// over. Calibration knob: the VAD's own hangover (300 ms) comes first, so
/// the question is put about 600 ms after the last word.
pub const TURN_PAUSE_MS: u32 = 300;
/// Quiet this long ends the turn whatever the model said: it thought you were
/// mid-sentence, but nobody pauses this long. Pipecat's default.
pub const TURN_BACKSTOP_MS: u32 = 3_000;
/// The model says "finished" above this.
pub const COMPLETE_ABOVE: f32 = 0.5;

/// The model's window: the last 8 s.
pub const SAMPLES: usize = 8 * SAMPLE_RATE as usize;
pub const MELS: usize = 80;
pub const FRAMES: usize = 800;

const N_FFT: usize = 400;
const HOP: usize = 160;
const BINS: usize = N_FFT / 2 + 1;
/// Kept before the first word, on top of the 200 ms `speech_ranges` pads.
const PRE_SPEECH: usize = 300 * SAMPLE_RATE as usize / 1000;

/// The part of a recording the model is shown: from just before the first
/// word to now, at most the last 8 s. `None`: no speech in it yet.
pub fn turn_audio(samples: &[f32]) -> Option<Vec<f32>> {
    let first = speech_ranges(samples).first()?.start;
    let from = first
        .saturating_sub(PRE_SPEECH)
        .max(samples.len().saturating_sub(SAMPLES));
    Some(samples[from..].to_vec())
}

/// Log-mel features, `MELS` rows of `FRAMES`, row after row: what
/// `WhisperFeatureExtractor(chunk_length=8, do_normalize=True)` gives for
/// `audio` padded with silence in front to 8 s (or cut to its last 8 s).
pub fn features(audio: &[f32]) -> Vec<f32> {
    let tail = &audio[audio.len().saturating_sub(SAMPLES)..];
    let mut x = vec![0f64; SAMPLES];
    for (o, s) in x[SAMPLES - tail.len()..].iter_mut().zip(tail) {
        *o = f64::from(*s);
    }
    // Zero mean, unit variance, over the padded clip.
    let mean = x.iter().sum::<f64>() / SAMPLES as f64;
    let var = x.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / SAMPLES as f64;
    let scale = 1.0 / (var + 1e-7).sqrt();
    // Reflect-padded by half a window on each side, so frames are centred.
    let half = N_FFT / 2;
    let padded: Vec<f64> = (0..SAMPLES + N_FFT)
        .map(|i| {
            let j = if i < half {
                half - i
            } else if i >= half + SAMPLES {
                2 * SAMPLES + half - 2 - i
            } else {
                i - half
            };
            (x[j] - mean) * scale
        })
        .collect();

    let tau = std::f64::consts::TAU;
    let (cos, sin): (Vec<f64>, Vec<f64>) = (0..N_FFT)
        .map(|n| (tau * n as f64 / N_FFT as f64).sin_cos())
        .map(|(s, c)| (c, s))
        .unzip();
    // Periodic Hann.
    let window: Vec<f64> = cos.iter().map(|c| 0.5 - 0.5 * c).collect();
    let filters = mel_filters();

    let mut out = vec![0f32; MELS * FRAMES];
    let mut power = [0f64; BINS];
    let mut max = f32::NEG_INFINITY;
    for t in 0..FRAMES {
        let frame = &padded[t * HOP..t * HOP + N_FFT];
        // The silence in front is one value repeated: its frames are all the
        // same, so the spectrum before it stands. Saves most of a short turn.
        if t == 0 || frame != &padded[(t - 1) * HOP..(t - 1) * HOP + N_FFT] {
            // ponytail: a plain DFT (400 is not a power of two), ~100 ms for a
            // full 8 s. A mixed-radix FFT if a pause ever feels held up by it.
            for (k, p) in power.iter_mut().enumerate() {
                let (mut re, mut im, mut at) = (0f64, 0f64, 0usize);
                for (v, w) in frame.iter().zip(&window) {
                    let v = v * w;
                    re += v * cos[at];
                    im -= v * sin[at];
                    at += k;
                    if at >= N_FFT {
                        at -= N_FFT;
                    }
                }
                *p = re * re + im * im;
            }
        }
        for (m, filter) in filters.iter().enumerate() {
            let mel: f64 = filter.iter().zip(&power).map(|(f, p)| f * p).sum();
            let v = mel.max(1e-10).log10() as f32;
            max = max.max(v);
            out[m * FRAMES + t] = v;
        }
    }
    for v in &mut out {
        *v = (v.max(max - 8.0) + 4.0) / 4.0;
    }
    out
}

/// Slaney-scale triangular filters, area-normalised: `MELS` rows of `BINS`.
fn mel_filters() -> Vec<[f64; BINS]> {
    let step = 6.4f64.ln() / 27.0;
    let to_mel = |hz: f64| {
        if hz >= 1000.0 {
            15.0 + (hz / 1000.0).ln() / step
        } else {
            3.0 * hz / 200.0
        }
    };
    let to_hz = |mel: f64| {
        if mel >= 15.0 {
            1000.0 * (step * (mel - 15.0)).exp()
        } else {
            200.0 * mel / 3.0
        }
    };
    let nyquist = f64::from(SAMPLE_RATE) / 2.0;
    let top = to_mel(nyquist);
    let edges: Vec<f64> = (0..MELS + 2)
        .map(|i| to_hz(top * i as f64 / (MELS + 1) as f64))
        .collect();
    (0..MELS)
        .map(|m| {
            let (lo, mid, hi) = (edges[m], edges[m + 1], edges[m + 2]);
            let mut row = [0f64; BINS];
            for (i, w) in row.iter_mut().enumerate() {
                let hz = nyquist * i as f64 / (BINS - 1) as f64;
                let tri = ((hz - lo) / (mid - lo)).min((hi - hz) / (hi - mid));
                *w = tri.max(0.0) * 2.0 / (hi - lo);
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2.5 s: a 220 Hz tone that swells and drops every quarter second, with
    /// a quiet 1.5 kHz one under it. The same clip the reference was run on.
    fn clip() -> Vec<f32> {
        (0..40_000)
            .map(|i| {
                let t = f64::from(i) / 16_000.0;
                let amp = if (i / 4_000) % 2 == 0 { 0.3 } else { 0.06 };
                (amp * (std::f64::consts::TAU * 220.0 * t).sin()
                    + 0.05 * (std::f64::consts::TAU * 1500.0 * t).sin()) as f32
            })
            .collect()
    }

    #[test]
    fn features_match_the_reference_implementation() {
        // The same math in numpy (np.fft.rfft, as transformers and pipecat do
        // it) on clip() padded in front to 8 s: (mel, frame, value), and the sum.
        const REFERENCE: [(usize, usize, f32); 8] = [
            (0, 0, -0.169808),
            (3, 560, 1.451067),
            (5, 600, 1.730444),
            (10, 700, 1.166379),
            (40, 650, 0.481512),
            (47, 799, 0.186627),
            (79, 555, -0.169808),
            (20, 300, -0.169808),
        ];
        const REFERENCE_SUM: f64 = -4416.519;
        let f = features(&clip());
        assert_eq!(f.len(), MELS * FRAMES);
        for (m, t, want) in REFERENCE {
            let got = f[m * FRAMES + t];
            assert!(
                (got - want).abs() < 2e-3,
                "mel {m} frame {t}: {got} vs {want}"
            );
        }
        let sum: f64 = f.iter().map(|v| f64::from(*v)).sum();
        assert!((sum - REFERENCE_SUM).abs() < 5.0, "sum {sum}");
    }

    #[test]
    fn longer_than_the_window_keeps_the_end() {
        let long = [vec![0.5f32; 50_000], clip(), vec![0.0; SAMPLES - 40_000]].concat();
        let tail = [clip(), vec![0.0; SAMPLES - 40_000]].concat();
        assert_eq!(features(&long), features(&tail));
        assert_eq!(features(&[]).len(), MELS * FRAMES);
    }

    #[test]
    fn the_model_is_shown_the_turn_from_just_before_its_first_word() {
        assert_eq!(turn_audio(&vec![0.0001; 48_000]), None);
        // 3 s of room, then speech, then a pause.
        let noise = |n: usize| (0..n).map(|i| if i % 2 == 0 { 1e-4 } else { -1e-4 });
        let rec: Vec<f32> = noise(48_000).chain(clip()).chain(noise(9_600)).collect();
        let shown = turn_audio(&rec).unwrap();
        // 500 ms before the first word, give or take the VAD's onset.
        let lead = shown.len() as i64 - (40_000 + 9_600);
        assert!((6_000..=10_000).contains(&lead), "lead {lead}");
        // A long ramble: only the last 8 s.
        let ramble: Vec<f32> = clip().into_iter().cycle().take(SAMPLES * 2).collect();
        assert_eq!(turn_audio(&ramble).unwrap().len(), SAMPLES);
    }
}

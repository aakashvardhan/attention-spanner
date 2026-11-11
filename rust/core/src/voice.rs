//! Voice brain dump: which parts of the mic signal are speech, the WAV we
//! upload, and tidying the transcript. Audio arrives already at 16 kHz mono
//! (the browser's AudioContext resamples) with the browser's own noise
//! suppression on; this is the last gate before anything leaves the device.

use std::ops::Range;

pub const SAMPLE_RATE: u32 = 16_000;
/// 30 ms: the VAD's unit of decision.
pub const FRAME: usize = 480;
const FRAME_MS: u32 = 30;
/// Quiet this long after speech ends the recording on its own.
pub const SILENCE_STOP_MS: u32 = 2_500;
/// Less speech than this in a clip is a cough or a bump: nothing is sent.
pub(crate) const MIN_SPEECH_MS: u32 = 400;
/// Hard cap on one recording (about 5.8 MB as WAV; Groq takes 25 MB).
pub const MAX_RECORD_MS: u32 = 180_000;

/// Loud frames in a row before it counts as speech (a click is one or two).
const ONSET_FRAMES: u32 = 3;
/// Quiet frames speech may hold through (the gaps inside words).
const HANGOVER_FRAMES: u32 = 10;
/// How far above the room's noise floor a frame must be.
const ONSET_DB: f32 = 10.0;
/// Below this is silence whatever the floor says (a muted mic reads -inf).
const ABS_MIN_DB: f32 = -55.0;
/// Quieter than this is digital silence, not a room.
const SILENT_DB: f32 = -100.0;
/// The floor never starts higher than this, so talking from the first frame still registers.
const START_FLOOR_DB: f32 = -45.0;
/// Kept on each side of a speech range, so word edges are not clipped.
const PAD_MS: u32 = 200;
/// Gaps shorter than this between speech ranges are kept: a breath, not a pause.
const MERGE_GAP_MS: u32 = 500;

const fn ms_to_samples(ms: u32) -> usize {
    (ms * SAMPLE_RATE / 1000) as usize
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VadEvent {
    Quiet,
    Speech,
    /// Speech was heard, then `SILENCE_STOP_MS` of quiet: stop recording.
    SilenceTimeout,
}

/// Energy voice-activity detector with an adaptive noise floor.
// ponytail: energy only; add a zero-crossing or spectral check if a noisy room still trips it.
#[derive(Debug, Default)]
pub struct Vad {
    floor_db: Option<f32>,
    onset: u32,
    hang: u32,
    speaking: bool,
    heard: bool,
    quiet_frames: u32,
    /// Quiet that ends a recording; 0 means `SILENCE_STOP_MS`.
    silence_ms: u32,
    /// Whether the last frame pushed was above the threshold.
    pub loud: bool,
}

fn rms_db(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return f32::NEG_INFINITY;
    }
    let mean_sq = frame.iter().map(|s| s * s).sum::<f32>() / frame.len() as f32;
    10.0 * mean_sq.log10()
}

impl Vad {
    pub fn new() -> Self {
        Self::default()
    }

    /// A VAD that ends a turn after `ms` of quiet (a conversation wants it short).
    pub fn with_silence(ms: u32) -> Self {
        Self {
            silence_ms: ms,
            ..Self::default()
        }
    }

    /// Currently inside speech.
    pub fn speaking(&self) -> bool {
        self.speaking
    }

    /// One frame (ideally `FRAME` samples) in, one decision out.
    pub fn push(&mut self, frame: &[f32]) -> VadEvent {
        // Digital silence (a mic warming up reads exact zeros) says nothing about the room:
        // it neither seeds nor moves the floor, or plain noise after it would read as speech.
        let db = rms_db(frame).max(SILENT_DB);
        let floor = match self.floor_db {
            Some(f) => f,
            None if db > SILENT_DB => *self.floor_db.insert(db.min(START_FLOOR_DB)),
            None => START_FLOOR_DB,
        };
        self.loud = db > floor + ONSET_DB && db > ABS_MIN_DB;
        if !self.loud && db > SILENT_DB {
            // The floor follows the room: quickly down, slowly up, never during speech.
            let alpha = if db < floor { 0.3 } else { 0.05 };
            self.floor_db = Some(floor + alpha * (db - floor));
        }

        self.onset = if self.loud { self.onset + 1 } else { 0 };
        if self.speaking {
            self.hang = if self.loud { 0 } else { self.hang + 1 };
            if self.hang > HANGOVER_FRAMES {
                self.speaking = false;
            }
        } else if self.onset >= ONSET_FRAMES {
            self.speaking = true;
            self.heard = true;
            self.hang = 0;
        }

        if self.speaking {
            self.quiet_frames = 0;
            VadEvent::Speech
        } else if self.heard {
            self.quiet_frames += 1;
            let stop = if self.silence_ms == 0 {
                SILENCE_STOP_MS
            } else {
                self.silence_ms
            };
            if self.quiet_frames * FRAME_MS >= stop {
                VadEvent::SilenceTimeout
            } else {
                VadEvent::Quiet
            }
        } else {
            VadEvent::Quiet
        }
    }
}

/// Speech in a whole clip as sample ranges: padded, close ones merged, and
/// nothing at all if the clip holds less than `MIN_SPEECH_MS` of speech.
pub(crate) fn speech_ranges(samples: &[f32]) -> Vec<Range<usize>> {
    let mut vad = Vad::new();
    let mut frames: Vec<Range<usize>> = Vec::new(); // in frame indices
    let mut start = None;
    let mut last_loud = 0;
    for (i, frame) in samples.chunks(FRAME).enumerate() {
        vad.push(frame);
        if vad.speaking() {
            // The onset frames were speech too; the VAD only knew it after them.
            start.get_or_insert((i + 1).saturating_sub(ONSET_FRAMES as usize));
            if vad.loud {
                last_loud = i;
            }
        } else if let Some(s) = start.take() {
            frames.push(s..last_loud + 1);
        }
    }
    if let Some(s) = start {
        frames.push(s..last_loud + 1);
    }

    let speech_frames: usize = frames.iter().map(|r| r.len()).sum();
    if (speech_frames as u32) * FRAME_MS < MIN_SPEECH_MS {
        return Vec::new();
    }

    let (pad, gap) = (ms_to_samples(PAD_MS), ms_to_samples(MERGE_GAP_MS));
    let mut out: Vec<Range<usize>> = Vec::new();
    for r in frames {
        let r = (r.start * FRAME).saturating_sub(pad)..(r.end * FRAME + pad).min(samples.len());
        match out.last_mut() {
            Some(prev) if r.start <= prev.end + gap => prev.end = prev.end.max(r.end),
            _ => out.push(r),
        }
    }
    out
}

/// Only the speech, joined: what gets uploaded.
pub fn trim_to_speech(samples: &[f32]) -> Vec<f32> {
    speech_ranges(samples)
        .into_iter()
        .flat_map(|r| samples[r].iter().copied())
        .collect()
}

/// 16-bit PCM WAV, mono, `SAMPLE_RATE`.
pub fn encode_wav(samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub const GROQ_TRANSCRIBE_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
pub const GROQ_MODEL: &str = "whisper-large-v3-turbo";
pub const GROQ_TIMEOUT_MS: i32 = 20_000;

/// What to tell the user for a failed transcription; `None` = worth one retry.
pub fn groq_error(status: u16) -> Option<&'static str> {
    match status {
        401 | 403 => Some("Groq rejected the key. Check it in Settings."),
        413 => Some("That was too long to send. Try a shorter take."),
        429 => Some("Groq is rate-limiting. Try again in a minute."),
        500..=599 => None,
        _ => Some("Groq couldn't transcribe that."),
    }
}

/// The text of Groq's `response_format=json` reply.
pub fn parse_groq_reply(body: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("text")?
        .as_str()
        .map(str::to_string)
}

/// Where the transcript goes: into `draft` at char index `at`, spaced from
/// its neighbours, never past `max` chars. Returns the new text, the cursor
/// after the insert, and whether it had to be cut.
pub fn insert_transcript(draft: &str, at: usize, words: &str, max: usize) -> (String, usize, bool) {
    let chars: Vec<char> = draft.chars().collect();
    let at = at.min(chars.len());
    let (before, after): (String, String) =
        (chars[..at].iter().collect(), chars[at..].iter().collect());
    let lead = if before.is_empty() || before.ends_with(char::is_whitespace) {
        ""
    } else {
        " "
    };
    let trail = if after.is_empty() || after.starts_with(char::is_whitespace) {
        ""
    } else {
        " "
    };
    let room = max.saturating_sub(before.chars().count() + after.chars().count());
    let piece: String = format!("{lead}{words}{trail}");
    let cut = piece.chars().count() > room;
    let piece: String = piece.chars().take(room).collect();
    let cursor = at + piece.chars().count();
    (format!("{before}{piece}{after}"), cursor, cut)
}

const FILLERS: &[&str] = &[
    "um", "umm", "uh", "uhh", "uhm", "erm", "er", "hmm", "hm", "mm", "mhm",
];

/// What Whisper says over silence or noise; a transcript that is only this is empty.
const HALLUCINATIONS: &[&str] = &[
    "you",
    "thank you",
    "thanks",
    "bye",
    "thank you for watching",
    "thanks for watching",
    "thank you very much",
    "subtitles by the amaraorg community",
];

fn bare(word: &str) -> String {
    word.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The transcript, minus fillers, stutters and silence hallucinations.
pub fn clean_transcript(text: &str) -> String {
    let mut kept: Vec<String> = Vec::new();
    for word in text.split_whitespace() {
        // [BLANK_AUDIO], (music), [Music]: sound labels, not words.
        if (word.starts_with('[') && word.ends_with(']'))
            || (word.starts_with('(') && word.ends_with(')'))
        {
            continue;
        }
        if FILLERS.contains(&bare(word).as_str()) {
            // Keep a sentence end the filler carried ("...it, um.").
            if let (Some(end @ ('.' | '?' | '!')), Some(prev)) =
                (word.chars().last(), kept.last_mut())
            {
                let prev_end = prev.chars().last();
                if prev_end == Some(',') {
                    prev.pop();
                }
                if !matches!(prev.chars().last(), Some('.' | '?' | '!')) {
                    prev.push(end);
                }
            }
            continue;
        }
        kept.push(word.to_string());
    }

    // Stutters: "I I I think" -> "I think". Short words repeat by accident;
    // longer ones ("very very") only count when said three times or more.
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < kept.len() {
        let w = bare(&kept[i]);
        let run = kept[i..].iter().take_while(|k| bare(k) == w).count();
        let collapse = !w.is_empty() && (run >= 3 || (run == 2 && w.chars().count() <= 2));
        if collapse {
            out.push(kept[i + run - 1].clone());
        } else {
            out.extend(kept[i..i + run].iter().cloned());
        }
        i += run;
    }

    let joined = out.join(" ");
    let whole = joined
        .split_whitespace()
        .map(bare)
        .collect::<Vec<_>>()
        .join(" ");
    if whole.is_empty() || HALLUCINATIONS.contains(&whole.as_str()) {
        return String::new();
    }
    joined
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic white noise in [-amp, amp].
    fn noise(n: usize, amp: f32, seed: u32) -> Vec<f32> {
        let mut x = seed;
        (0..n)
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((x >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0) * amp
            })
            .collect()
    }

    fn tone(n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| {
                amp * (i as f32 * 2.0 * std::f32::consts::PI * 220.0 / SAMPLE_RATE as f32).sin()
            })
            .collect()
    }

    fn mix(a: &mut [f32], b: &[f32], at: usize) {
        for (x, y) in a[at..].iter_mut().zip(b) {
            *x += y;
        }
    }

    const S: usize = SAMPLE_RATE as usize;

    #[test]
    fn a_voice_in_room_noise_is_one_padded_range() {
        let mut clip = noise(3 * S, 0.003, 1);
        mix(&mut clip, &tone(S, 0.3), S); // 1 s of "speech" at 1..2 s
        let r = speech_ranges(&clip);
        assert_eq!(r.len(), 1, "{r:?}");
        let pad = ms_to_samples(PAD_MS);
        // Starts within one frame of the onset, minus padding; ends after the tone plus padding.
        assert!(
            (r[0].start as i64 - (S - pad) as i64).abs() <= FRAME as i64,
            "{r:?}"
        );
        assert!(
            r[0].end >= 2 * S + pad - FRAME && r[0].end <= 2 * S + pad + FRAME,
            "{r:?}"
        );
        let trimmed = trim_to_speech(&clip);
        assert!(trimmed.len() < clip.len() / 2);
    }

    #[test]
    fn noise_alone_and_digital_silence_are_not_speech() {
        assert!(speech_ranges(&noise(3 * S, 0.01, 2)).is_empty());
        assert!(speech_ranges(&vec![0.0; 3 * S]).is_empty());
        // A mic that warms up with exact zeros, then room noise: still nothing.
        let mut clip = vec![0.0; S / 2];
        clip.extend(noise(3 * S, 0.004, 10));
        assert!(speech_ranges(&clip).is_empty());
        assert!(speech_ranges(&[]).is_empty());
        assert!(trim_to_speech(&[]).is_empty());
    }

    #[test]
    fn a_click_or_a_cough_is_not_speech() {
        let mut clip = noise(2 * S, 0.003, 3);
        mix(&mut clip, &tone(FRAME, 0.9), S); // one loud frame
        assert!(speech_ranges(&clip).is_empty());
        let mut clip = noise(2 * S, 0.003, 4);
        mix(&mut clip, &tone(ms_to_samples(200), 0.5), S); // shorter than MIN_SPEECH_MS
        assert!(speech_ranges(&clip).is_empty());
    }

    #[test]
    fn a_breath_between_phrases_merges_and_a_pause_splits() {
        let mut clip = noise(6 * S, 0.003, 5);
        mix(&mut clip, &tone(S / 2, 0.3), S / 2);
        mix(&mut clip, &tone(S / 2, 0.3), S + ms_to_samples(300)); // gap ~300 ms + hangover
        assert_eq!(speech_ranges(&clip).len(), 1);

        let mut clip = noise(6 * S, 0.003, 6);
        mix(&mut clip, &tone(S / 2, 0.3), S / 2);
        mix(&mut clip, &tone(S / 2, 0.3), 4 * S); // 3 s pause
        assert_eq!(speech_ranges(&clip).len(), 2);
    }

    #[test]
    fn talking_from_the_first_frame_still_counts() {
        let mut clip = tone(S, 0.3);
        clip.extend(noise(S, 0.003, 7));
        let r = speech_ranges(&clip);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].start, 0);
    }

    #[test]
    fn quiet_after_speech_times_out_but_quiet_before_never_does() {
        let mut vad = Vad::new();
        for f in noise(5 * S, 0.003, 8).chunks(FRAME) {
            assert_eq!(vad.push(f), VadEvent::Quiet);
        }
        for f in tone(S / 2, 0.3).chunks(FRAME) {
            vad.push(f);
        }
        assert!(vad.heard);
        let quiet = noise(3 * S, 0.003, 9);
        let events: Vec<_> = quiet.chunks(FRAME).map(|f| vad.push(f)).collect();
        let first_stop = events
            .iter()
            .position(|e| *e == VadEvent::SilenceTimeout)
            .unwrap();
        let ms = (first_stop as u32 + 1) * FRAME_MS;
        let hang = (HANGOVER_FRAMES + 1) * FRAME_MS;
        assert!(
            ms >= SILENCE_STOP_MS && ms <= SILENCE_STOP_MS + hang + FRAME_MS,
            "{ms}"
        );

        // A conversation turn ends sooner.
        let mut turn = Vad::with_silence(700);
        for f in tone(S / 2, 0.3).chunks(FRAME) {
            turn.push(f);
        }
        let stop = quiet
            .chunks(FRAME)
            .position(|f| turn.push(f) == VadEvent::SilenceTimeout)
            .unwrap() as u32;
        assert!((stop + 1) * FRAME_MS <= 700 + hang + FRAME_MS, "{stop}");
    }

    #[test]
    fn wav_has_the_right_header_and_clamps() {
        let wav = encode_wav(&[0.0, 1.0, -1.0, 2.0, -2.0]);
        assert_eq!(wav.len(), 44 + 10);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 10);
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(
            u32::from_le_bytes(wav[24..28].try_into().unwrap()),
            SAMPLE_RATE
        );
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 10);
        let s = |i: usize| i16::from_le_bytes([wav[44 + 2 * i], wav[45 + 2 * i]]);
        assert_eq!(
            [s(0), s(1), s(2), s(3), s(4)],
            [0, i16::MAX, -i16::MAX, i16::MAX, -i16::MAX]
        );
        assert_eq!(encode_wav(&[]).len(), 44);
    }

    #[test]
    fn groq_statuses_and_replies() {
        assert!(groq_error(401).unwrap().contains("key"));
        assert!(groq_error(429).unwrap().contains("minute"));
        assert!(groq_error(413).is_some());
        assert_eq!(groq_error(503), None);
        assert_eq!(
            parse_groq_reply(r#"{"text":" Buy milk.","x_groq":{}}"#).as_deref(),
            Some(" Buy milk.")
        );
        assert_eq!(parse_groq_reply("not json"), None);
        assert_eq!(parse_groq_reply(r#"{"error":{}}"#), None);
    }

    #[test]
    fn transcripts_insert_at_the_cursor_spaced_and_capped() {
        assert_eq!(
            insert_transcript("", 0, "buy milk", 100),
            ("buy milk".into(), 8, false)
        );
        assert_eq!(
            insert_transcript("hello", 5, "buy milk", 100),
            ("hello buy milk".into(), 14, false)
        );
        assert_eq!(
            insert_transcript("ab", 1, "x", 100),
            ("a x b".into(), 4, false)
        );
        assert_eq!(
            insert_transcript("ab ", 3, "x", 100),
            ("ab x".into(), 4, false)
        );
        assert_eq!(
            insert_transcript("héllo", 99, "ü", 100),
            ("héllo ü".into(), 7, false)
        );
        assert_eq!(
            insert_transcript("abc", 3, "defgh", 6),
            ("abc de".into(), 6, true)
        );
        assert_eq!(
            insert_transcript("abcdef", 6, "x", 6),
            ("abcdef".into(), 6, true)
        );
    }

    #[test]
    fn transcripts_lose_fillers_stutters_and_hallucinations() {
        let cases = [
            (
                "Um, I need to, uh, call the dentist.",
                "I need to, call the dentist.",
            ),
            ("I I I think it's fine", "I think it's fine"),
            ("it is very very late", "it is very very late"),
            ("no no no no stop", "no stop"),
            ("I forgot the rent, um.", "I forgot the rent."),
            ("  spaced \n out\twords ", "spaced out words"),
            ("[BLANK_AUDIO]", ""),
            ("(music) buy milk [Music]", "buy milk"),
            ("Thank you for watching!", ""),
            (" you ", ""),
            (
                "Thank you, Sam, for the notes",
                "Thank you, Sam, for the notes",
            ),
            ("Umm... hmm.", ""),
            ("", ""),
        ];
        for (input, want) in cases {
            assert_eq!(clean_transcript(input), want, "input: {input:?}");
        }
    }
}

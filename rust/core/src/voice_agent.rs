//! "Talk it through": a spoken Socratic partner in the reader. Groq Whisper
//! hears, Haiku thinks, Groq Orpheus speaks. This is the pure half: the
//! prompt, the turn history, and cutting a streamed reply into chunks the
//! TTS takes (it accepts at most 200 characters per request).

use serde_json::{json, Value};

pub const TTS_URL: &str = "https://api.groq.com/openai/v1/audio/speech";
pub const TTS_MODEL: &str = "canopylabs/orpheus-v1-english";
/// Orpheus's English voices, as (id, label) for the Settings picker.
pub const TTS_VOICES: [(&str, &str); 6] = [
    ("autumn", "Autumn"),
    ("diana", "Diana"),
    ("hannah", "Hannah"),
    ("austin", "Austin"),
    ("daniel", "Daniel"),
    ("troy", "Troy"),
];
pub const DEFAULT_VOICE: &str = "autumn";
/// What the Settings preview says.
pub const VOICE_SAMPLE: &str = "Hm, okay. So what problem is this paper actually solving?";

/// A stored voice, or the default when it is not one Orpheus has.
pub fn voice_or_default(v: &str) -> &str {
    TTS_VOICES
        .iter()
        .find(|(id, _)| *id == v)
        .map_or(DEFAULT_VOICE, |(id, _)| id)
}
/// Orpheus rejects longer input.
pub const TTS_MAX_CHARS: usize = 200;
/// Quiet this long after speech ends your turn. Calibration knob: lower
/// feels snappier, but cuts people off mid-thought.
pub const TURN_SILENCE_MS: u32 = 700;
/// The paper as context; past this only the opening is sent.
const PAPER_MAX_CHARS: usize = 40_000;
/// Turns of history sent each time.
const HISTORY_TURNS: usize = 12;

/// What is being read: a paper (in pages, with pictures) or a webpage (in sections).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Paper,
    Webpage,
}

impl Source {
    /// What the whole thing is called: "the paper", "the page".
    pub fn noun(self) -> &'static str {
        match self {
            Source::Paper => "paper",
            Source::Webpage => "page",
        }
    }

    /// What it comes in: pages of a paper, sections of a webpage.
    pub fn part(self) -> &'static str {
        match self {
            Source::Paper => "page",
            Source::Webpage => "section",
        }
    }
}

pub fn agent_system(title: &str, source: Source) -> String {
    let (noun, part) = (source.noun(), source.part());
    format!(
        "You are a thinking partner, talking out loud with someone reading the {noun} \"{title}\". \
They speak, you reply, and your reply is spoken by a voice, so write the way people talk: \
one or two short sentences, contractions, plain words, no lists, no markdown, no math \
symbols, no emoji, no stage directions or bracketed tags. You ask, you never tell: never \
explain the {noun}, never summarise it, never give the answer, even when asked. Instead, \
reflect what they said in a few words if useful, then ask one question that makes them \
think further: what problem it solves, what the trick is, why it works, what would break \
it, how it compares to something they know. If they are wrong, ask a question that leads \
them to see it, and point to the {part} to look at. If they ask you to just explain, say \
warmly that you'd rather hear their take first, and ask what they think so far. \
Start a new conversation by asking what they're reading right now and what stood out."
    )
}

#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub agent: bool,
    pub text: String,
}

/// The text, capped, each page or section labelled.
pub fn paper_document(parts: &[String], source: Source) -> String {
    let mut doc = String::new();
    for (i, p) in parts.iter().enumerate() {
        doc.push_str(&format!("[{} {}]\n{}\n", source.part(), i + 1, p));
        if doc.len() > PAPER_MAX_CHARS {
            break;
        }
    }
    doc.chars().take(PAPER_MAX_CHARS).collect()
}

/// The conversation so far, then the line to answer. `page` is where they
/// are in a paper; a webpage in the side panel has no reading position.
pub fn turn_prompt(history: &[Turn], page: u32, source: Source) -> String {
    let start = history.len().saturating_sub(HISTORY_TURNS);
    let mut out = match source {
        Source::Paper => format!("They are on page {page}. "),
        Source::Webpage => String::new(),
    };
    out.push_str("The conversation so far:\n");
    if history.is_empty() {
        out.push_str("(nothing yet: open the conversation)\n");
    }
    for t in &history[start..] {
        out.push_str(if t.agent { "You: " } else { "Them: " });
        out.push_str(&t.text);
        out.push('\n');
    }
    out.push_str("Reply with what you say next, and nothing else.");
    out
}

/// Who speaks. Groq Orpheus first (it has a free tier); OpenAI takes over
/// for the rest of a session when Groq stops (its daily limit, a bad key),
/// if there is an OpenAI key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtsProvider {
    Groq,
    OpenAi,
}

pub const OPENAI_TTS_URL: &str = "https://api.openai.com/v1/audio/speech";
pub const OPENAI_TTS_MODEL: &str = "gpt-4o-mini-tts";
/// How OpenAI's voice is asked to sound.
pub const OPENAI_INSTRUCTIONS: &str = "Speak like a calm, curious friend explaining a research paper out loud: warm, unhurried, natural pauses between ideas, never a newsreader.";

impl TtsProvider {
    /// One request's text. Orpheus refuses past 200 characters; OpenAI takes
    /// about 2,000 tokens with the instructions, so a paragraph fits.
    pub fn max_chars(self) -> usize {
        match self {
            TtsProvider::Groq => TTS_MAX_CHARS,
            TtsProvider::OpenAi => 1_200,
        }
    }

    pub fn url(self) -> &'static str {
        match self {
            TtsProvider::Groq => TTS_URL,
            TtsProvider::OpenAi => OPENAI_TTS_URL,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            TtsProvider::Groq => "Groq",
            TtsProvider::OpenAi => "OpenAI",
        }
    }
}

/// The OpenAI voice closest to a chosen Orpheus one, so a switch mid-paper is not jarring.
pub fn openai_voice(orpheus: &str) -> &'static str {
    match voice_or_default(orpheus) {
        "diana" => "coral",
        "hannah" => "shimmer",
        "austin" => "cedar",
        "daniel" => "ash",
        "troy" => "onyx",
        _ => "marin",
    }
}

/// The speech request for `provider`. `voice` is the Settings (Orpheus) voice.
pub fn tts_body(provider: TtsProvider, text: &str, voice: &str) -> Value {
    match provider {
        TtsProvider::Groq => {
            json!({ "model": TTS_MODEL, "voice": voice_or_default(voice), "input": text, "response_format": "wav" })
        }
        TtsProvider::OpenAi => json!({
            "model": OPENAI_TTS_MODEL,
            "voice": openai_voice(voice),
            "input": text,
            "instructions": OPENAI_INSTRUCTIONS,
            "response_format": "wav",
        }),
    }
}

/// The first chunk goes out once it holds this much, so the voice starts
/// soon but not on a lone "Hm, okay." (each request restarts the intonation).
const FIRST_CHUNK_MIN_CHARS: usize = 40;

/// Hands out speakable chunks of a reply as it streams: whole sentences
/// only, as few requests as possible (each one resets Orpheus's intonation),
/// never over `TTS_MAX_CHARS`. The first chunk leaves as soon as it is
/// `FIRST_CHUNK_MIN_CHARS` long; later ones fill up to the cap.
#[derive(Debug)]
pub struct Chunker {
    taken: usize,
    pending: String,
    started: bool,
    max: usize,
}

impl Default for Chunker {
    fn default() -> Self {
        Self::with_max(TTS_MAX_CHARS)
    }
}

impl Chunker {
    /// Chunks of at most `max` characters (the provider's limit).
    pub fn with_max(max: usize) -> Self {
        Self {
            taken: 0,
            pending: String::new(),
            started: false,
            max,
        }
    }

    /// `so_far` is the whole reply so far. With `done`, everything left is flushed.
    pub fn take(&mut self, so_far: &str, done: bool) -> Vec<String> {
        let mut out = Vec::new();
        let Some(mut rest) = so_far.get(self.taken..) else {
            return out;
        };
        loop {
            let end = sentence_end(rest)
                .or_else(|| (done && !rest.trim().is_empty()).then_some(rest.len()));
            let Some(end) = end else { break };
            for piece in fit(rest[..end].trim(), self.max) {
                self.add(piece, &mut out);
            }
            self.taken += end;
            rest = &rest[end..];
        }
        if done && !self.pending.is_empty() {
            out.push(std::mem::take(&mut self.pending));
        }
        out
    }

    fn add(&mut self, sentence: String, out: &mut Vec<String>) {
        let joined = self.pending.chars().count() + 1 + sentence.chars().count();
        if !self.pending.is_empty() && joined > self.max {
            out.push(std::mem::take(&mut self.pending));
            self.started = true;
        }
        if !self.pending.is_empty() {
            self.pending.push(' ');
        }
        self.pending.push_str(&sentence);
        if !self.started && self.pending.chars().count() >= FIRST_CHUNK_MIN_CHARS {
            out.push(std::mem::take(&mut self.pending));
            self.started = true;
        }
    }
}

/// Speech with its dead air cut: Orpheus pads a clip with up to ~2 s of
/// silence before the first word and leaves gaps of most of a second
/// between sentences, which is most of why it sounds robotic. Keeps 60 ms
/// before, 120 ms after, and at most 250 ms of any pause inside. Silence is
/// quieter than 35 dB below the clip's loudest 10 ms, or than -60 dBFS.
pub fn tighten(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    const LEAD: usize = 6;
    const TRAIL: usize = 12;
    const GAP: usize = 25;
    let hop = (sample_rate as usize / 100).max(1);
    let db: Vec<f32> = samples
        .chunks(hop)
        .map(|f| 10.0 * (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32 + 1e-12).log10())
        .collect();
    let peak = db.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let loud: Vec<bool> = db.iter().map(|d| *d > peak - 35.0 && *d > -60.0).collect();
    let (Some(first), Some(last)) = (loud.iter().position(|l| *l), loud.iter().rposition(|l| *l))
    else {
        return Vec::new();
    };
    let frame = |i: usize| &samples[i * hop..((i + 1) * hop).min(samples.len())];
    let mut out = Vec::with_capacity(samples.len());
    for i in first.saturating_sub(LEAD)..first {
        out.extend_from_slice(frame(i));
    }
    let mut quiet: Vec<usize> = Vec::new();
    for (i, &is_loud) in loud.iter().enumerate().take(last + 1).skip(first) {
        if is_loud {
            // A long pause keeps its edges (the breath out, the breath in), not its middle.
            let keep: Vec<usize> = if quiet.len() > GAP {
                [&quiet[..GAP / 2], &quiet[quiet.len() - (GAP - GAP / 2)..]].concat()
            } else {
                quiet.clone()
            };
            quiet.clear();
            for q in keep {
                out.extend_from_slice(frame(q));
            }
            out.extend_from_slice(frame(i));
        } else {
            quiet.push(i);
        }
    }
    for i in last + 1..(last + 1 + TRAIL).min(loud.len()) {
        out.extend_from_slice(frame(i));
    }
    out
}

/// Byte index just past the first sentence end (". " "? " "! " or a newline).
fn sentence_end(s: &str) -> Option<usize> {
    let b = s.as_bytes();
    (0..b.len()).find_map(|i| match b[i] {
        b'\n' => Some(i + 1),
        b'.' | b'?' | b'!' if b.get(i + 1).is_some_and(|c| c.is_ascii_whitespace()) => Some(i + 1),
        _ => None,
    })
}

/// A sentence cut to TTS-sized pieces: at a comma if one fits, else a space.
fn fit(s: &str, max: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = s;
    while rest.chars().count() > max {
        let limit = rest.char_indices().nth(max).map_or(rest.len(), |(i, _)| i);
        let head = &rest[..limit];
        let cut = head
            .rfind(", ")
            .map(|i| i + 1)
            .or_else(|| head.rfind(' '))
            .filter(|&i| i > 0)
            .unwrap_or(limit);
        out.push(rest[..cut].trim().to_string());
        rest = rest[cut..].trim_start();
    }
    if !rest.is_empty() {
        out.push(rest.to_string());
    }
    out
}

/// The sentence of a spoken chunk that is playing `frac` (0..1) of the way
/// through it. ponytail: guessed by character count, not word timings; close
/// enough to follow along, word timestamps if it drifts on long sentences.
pub fn sentence_at(line: &str, frac: f64) -> &str {
    let target = (frac.clamp(0.0, 1.0) * line.len() as f64) as usize;
    let mut start = 0;
    while let Some(end) = sentence_end(&line[start..]).map(|e| start + e) {
        if end >= target || end >= line.len() {
            return line[start..end].trim();
        }
        start = end;
    }
    line[start..].trim()
}

/// A failed speech request: worth waiting and sending the same chunk again,
/// or not (the message says why).
#[derive(Debug, Clone, PartialEq)]
pub enum TtsFailure {
    Wait { secs: u32 },
    Stop(&'static str),
}

/// Where to go after `provider` gave up for good: OpenAI, once, if there is a key.
pub fn fallback(provider: TtsProvider, has_openai_key: bool) -> Option<TtsProvider> {
    (provider == TtsProvider::Groq && has_openai_key).then_some(TtsProvider::OpenAi)
}

/// Longest wait taken on Groq's word; past it, it is a daily limit.
pub const MAX_RETRY_WAIT_SECS: u32 = 90;

/// What a failed speech request means. `retry_after` is the 429's header.
pub fn tts_failure(
    provider: TtsProvider,
    status: u16,
    body: &str,
    retry_after: Option<&str>,
) -> TtsFailure {
    const DAILY: &str = "Groq's daily speech limit for this key is used up. It resets within a day; a paid Groq plan raises it.";
    if provider == TtsProvider::OpenAi {
        return match status {
            401 | 403 => TtsFailure::Stop("OpenAI rejected the API key."),
            429 if body.contains("insufficient_quota") => {
                TtsFailure::Stop("OpenAI says this key has no credit left.")
            }
            429 => match retry_after.and_then(|r| r.trim().parse::<f64>().ok()) {
                Some(s) if s <= f64::from(MAX_RETRY_WAIT_SECS) => TtsFailure::Wait {
                    secs: s.ceil().max(1.0) as u32,
                },
                _ => TtsFailure::Wait { secs: 10 },
            },
            500..=599 => TtsFailure::Wait { secs: 2 },
            _ => TtsFailure::Stop("OpenAI couldn't speak this time."),
        };
    }
    if body.contains("model_terms_required") {
        return TtsFailure::Stop("Orpheus needs its terms accepted once: open console.groq.com/playground, pick canopylabs/orpheus-v1-english, and accept.");
    }
    match status {
        401 | 403 => TtsFailure::Stop("Groq rejected the API key."),
        429 if body.contains("per day") || body.contains("(RPD)") || body.contains("(TPD)") => {
            TtsFailure::Stop(DAILY)
        }
        429 => match retry_after.and_then(|r| r.trim().parse::<f64>().ok()) {
            Some(s) if s <= f64::from(MAX_RETRY_WAIT_SECS) => TtsFailure::Wait {
                secs: s.ceil().max(1.0) as u32,
            },
            Some(_) => TtsFailure::Stop(DAILY),
            None => TtsFailure::Wait { secs: 10 },
        },
        500..=599 => TtsFailure::Wait { secs: 2 },
        _ => TtsFailure::Stop("Groq couldn't speak this time."),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn webpage_talk_is_about_the_page_and_still_never_tells() {
        let sys = agent_system("Notes", Source::Webpage);
        assert!(sys.contains("you never tell") && sys.contains("the page \"Notes\""));
        assert!(paper_document(&["a".into(), "b".into()], Source::Webpage).contains("[section 2]"));
        let p = turn_prompt(&[], 3, Source::Webpage);
        assert!(!p.contains("page 3") && !p.contains("section 3"));
        assert!(turn_prompt(&[], 3, Source::Paper).contains("They are on page 3."));
    }

    use super::*;

    #[test]
    fn sentence_at_follows_the_clock() {
        let l = "One two. Three four five six seven. End.";
        assert_eq!(sentence_at(l, 0.0), "One two.");
        assert_eq!(sentence_at(l, 0.5), "Three four five six seven.");
        assert_eq!(sentence_at(l, 0.99), "End.");
        assert_eq!(sentence_at("No stop at all", 0.7), "No stop at all");
    }

    #[test]
    fn hands_out_sentences_as_they_finish_across_any_chunking() {
        // A short reply is one request: one intonation from start to end.
        let reply = "Hm, okay. What problem is it solving? Say it in a line.";
        for cut in 1..reply.len() {
            let mut c = Chunker::default();
            let mut got = c.take(&reply[..cut], false);
            got.extend(c.take(reply, true));
            assert_eq!(got, [reply], "cut at {cut}");
        }
        // The first chunk leaves as soon as it is long enough, before the reply ends.
        let mut c = Chunker::default();
        assert_eq!(
            c.take(
                "Okay, so attention is the part doing the work. And the",
                false
            ),
            ["Okay, so attention is the part doing the work."]
        );
        assert_eq!(
            c.take(
                "Okay, so attention is the part doing the work. And the rest?",
                true
            ),
            ["And the rest?"]
        );
        // Later sentences share a request up to the cap.
        let long = "First one is long enough to go out alone now. Two. Three. Four.";
        assert_eq!(
            Chunker::default().take(long, true),
            [
                "First one is long enough to go out alone now.",
                "Two. Three. Four."
            ]
        );
        // Decimals and an unfinished sentence wait.
        assert!(Chunker::default()
            .take("It got 3.5 points", false)
            .is_empty());
    }

    #[test]
    fn never_sends_more_than_the_tts_takes() {
        let long = "word, ".repeat(80) + "end.";
        let mut c = Chunker::default();
        let pieces = c.take(&long, true);
        assert!(pieces.len() > 1);
        assert!(pieces
            .iter()
            .all(|p| p.chars().count() <= TTS_MAX_CHARS && !p.is_empty()));
        assert_eq!(
            pieces.join(" ").split_whitespace().count(),
            long.split_whitespace().count()
        );
        let unbroken = "x".repeat(450);
        assert!(fit(&unbroken, TTS_MAX_CHARS)
            .iter()
            .all(|p| p.chars().count() <= TTS_MAX_CHARS));
    }

    #[test]
    fn falls_back_from_groq_to_openai_once_and_only_with_a_key() {
        use TtsProvider::*;
        assert_eq!(fallback(Groq, true), Some(OpenAi));
        assert_eq!(fallback(Groq, false), None);
        assert_eq!(fallback(OpenAi, true), None);
        let stop = |f| matches!(f, TtsFailure::Stop(_));
        assert!(stop(tts_failure(OpenAi, 401, "", None)));
        assert!(stop(tts_failure(
            OpenAi,
            429,
            r#"{"error":{"code":"insufficient_quota"}}"#,
            None
        )));
        assert_eq!(
            tts_failure(OpenAi, 429, "", Some("3")),
            TtsFailure::Wait { secs: 3 }
        );
        // A paragraph fits one OpenAI request; never past its cap.
        let para = "This sentence is about forty characters. ".repeat(40);
        let chunks = Chunker::with_max(OpenAi.max_chars()).take(&para, true);
        assert!(chunks.len() <= 3 && chunks.iter().all(|c| c.chars().count() <= 1_200));
    }

    #[test]
    fn tighten_cuts_dead_air_but_keeps_the_words() {
        let sr = 1000; // 10 samples per 10 ms frame
        let tone = |ms: usize| {
            (0..ms)
                .map(|i| if i % 2 == 0 { 0.5 } else { -0.5 })
                .collect::<Vec<f32>>()
        };
        let hush = |ms: usize| vec![0.0001f32; ms];
        let clip = [
            hush(1800),
            tone(400),
            hush(800),
            tone(300),
            hush(100),
            tone(200),
            hush(500),
        ]
        .concat();
        let out = tighten(&clip, sr);
        // 60 lead + 400 + 250 (capped gap) + 300 + 100 (short gap kept) + 200 + 120 trail.
        assert_eq!(out.len(), 60 + 400 + 250 + 300 + 100 + 200 + 120);
        let loud = |v: &[f32]| v.iter().filter(|s| s.abs() > 0.1).count();
        assert_eq!(loud(&out), loud(&clip));
        assert!(tighten(&hush(500), sr).is_empty());
        assert!(tighten(&[], sr).is_empty());
    }

    #[test]
    fn the_prompt_keeps_recent_turns_and_the_page() {
        let history: Vec<Turn> = (0..20)
            .map(|i| Turn {
                agent: i % 2 == 0,
                text: format!("line {i}"),
            })
            .collect();
        let p = turn_prompt(&history, 4, Source::Paper);
        assert!(p.contains("page 4") && p.contains("line 19") && !p.contains("line 7\n"));
        assert!(turn_prompt(&[], 1, Source::Paper).contains("open the conversation"));
        assert_eq!(tts_body(TtsProvider::Groq, "hi", "troy")["voice"], "troy");
        assert_eq!(
            tts_body(TtsProvider::Groq, "hi", "nobody")["voice"],
            DEFAULT_VOICE
        );
        assert_eq!(tts_body(TtsProvider::Groq, "hi", "")["model"], TTS_MODEL);
        let o = tts_body(TtsProvider::OpenAi, "hi", "autumn");
        assert_eq!(
            (o["model"].as_str(), o["voice"].as_str()),
            (Some(OPENAI_TTS_MODEL), Some("marin"))
        );
        assert!(o["instructions"]
            .as_str()
            .is_some_and(|i| i.contains("friend")));
        let stop = |f| matches!(f, TtsFailure::Stop(_));
        assert!(stop(tts_failure(
            TtsProvider::Groq,
            400,
            r#"{"error":{"code":"model_terms_required"}}"#,
            None
        )));
        assert_eq!(
            tts_failure(TtsProvider::Groq, 401, "", None),
            TtsFailure::Stop("Groq rejected the API key.")
        );
        // The per-minute limit: wait as long as Groq says, then send the same chunk again.
        assert_eq!(
            tts_failure(TtsProvider::Groq, 429, "", Some("6.2")),
            TtsFailure::Wait { secs: 7 }
        );
        assert_eq!(
            tts_failure(TtsProvider::Groq, 429, "", None),
            TtsFailure::Wait { secs: 10 }
        );
        // The daily limit: no wait helps.
        let daily = r#"{"error":{"message":"Rate limit reached on tokens per day (TPD): Limit 3600, Used 3590"}}"#;
        assert!(stop(tts_failure(TtsProvider::Groq, 429, daily, Some("2"))));
        assert!(stop(tts_failure(TtsProvider::Groq, 429, "", Some("3600"))));
        assert_eq!(
            tts_failure(TtsProvider::Groq, 503, "", None),
            TtsFailure::Wait { secs: 2 }
        );
    }
}

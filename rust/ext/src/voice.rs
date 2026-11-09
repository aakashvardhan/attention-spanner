//! The brain dump's voice input: the mic graph and the Groq upload. The rules
//! (VAD, trimming, WAV, error wording) are reader_core::voice; this is only
//! the browser plumbing around them.
//!
//! mic → (browser noise suppression, echo cancellation, AGC) → 16 kHz
//! AudioContext (the browser resamples) → 100 Hz high-pass → worklet tap →
//! 30 ms frames → `Vad` here, in wasm.

use crate::chrome;
use crate::js::{to_js, wait};
use js_sys::{Array, Float32Array, Reflect, Uint8Array};
use reader_core::voice::{
    groq_error, parse_groq_reply, Vad, VadEvent, FRAME, GROQ_MODEL, GROQ_TIMEOUT_MS,
    GROQ_TRANSCRIBE_URL, MAX_RECORD_MS, SAMPLE_RATE,
};
use reader_core::voice_agent::{fallback, TtsFailure, TtsProvider, MAX_RETRY_WAIT_SECS};
use serde_json::json;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AudioBuffer, AudioContext, AudioContextOptions, AudioWorkletNode, BiquadFilterType,
    MediaStream, MessageEvent,
};

const MAX_SAMPLES: usize = (MAX_RECORD_MS as usize / 1000) * SAMPLE_RATE as usize;

/// What the recorder tells the page, once per 30 ms frame.
pub enum Heard {
    /// Recording so far (ms) and whether the VAD hears speech right now.
    Frame { ms: u32, speaking: bool },
    /// Quiet long enough after speech, or the length cap: stop and send.
    Done,
}

/// A live recording. Dropping it stops the mic (the light goes off) and
/// closes the audio graph, however the recording ends.
pub struct Recorder {
    stream: MediaStream,
    ctx: AudioContext,
    tap: AudioWorkletNode,
    samples: Rc<RefCell<Vec<f32>>>,
    _on_frame: Closure<dyn FnMut(MessageEvent)>,
}

impl Recorder {
    /// Stops and hands back everything recorded.
    pub fn finish(self) -> Vec<f32> {
        std::mem::take(&mut *self.samples.borrow_mut())
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        self.tap.port().map(|p| p.set_onmessage(None)).ok();
        for track in self.stream.get_tracks().iter() {
            track.unchecked_into::<web_sys::MediaStreamTrack>().stop();
        }
        let _ = self.ctx.close();
    }
}

/// The getUserMedia failure, in words.
pub(crate) fn mic_error(e: &JsValue) -> String {
    let name = e
        .dyn_ref::<web_sys::DomException>()
        .map(|d| d.name())
        .unwrap_or_default();
    match name.as_str() {
        "NotAllowedError" | "SecurityError" => {
            "The mic is blocked. Click the icon at the right of the address bar to allow it.".into()
        }
        "NotFoundError" | "OverconstrainedError" => "No microphone found.".into(),
        "NotReadableError" | "AbortError" => "The mic is busy in another app.".into(),
        _ => "Couldn't start the mic.".into(),
    }
}

/// Ask for the mic and start listening. `on_heard` runs on the main thread for every frame.
/// `silence_ms` of quiet after speech ends the recording.
pub async fn start(
    silence_ms: u32,
    mut on_heard: impl FnMut(Heard) + 'static,
) -> Result<Recorder, String> {
    let devices = web_sys::window()
        .and_then(|w| w.navigator().media_devices().ok())
        .ok_or("This browser has no mic access.")?;
    let constraints = to_js(&json!({
        "audio": { "channelCount": 1, "noiseSuppression": true, "echoCancellation": true, "autoGainControl": true }
    }))
    .map_err(|_| "constraints")?;
    let stream: MediaStream =
        wait(devices.get_user_media_with_constraints(constraints.unchecked_ref()))
            .await
            .map_err(|e| mic_error(&e))?
            .unchecked_into();

    // From here on, any failure must still release the mic: build inside a
    // closure and stop the tracks if it errs.
    let built = async {
        let opts = AudioContextOptions::new();
        opts.set_sample_rate(SAMPLE_RATE as f32);
        let ctx = AudioContext::new_with_context_options(&opts)?;
        let close_on_err = ctx.clone();
        let rest = async {
            wait(
                ctx.audio_worklet()?
                    .add_module(&chrome::get_url("mic-worklet.js")),
            )
            .await?;
            let source = ctx.create_media_stream_source(&stream)?;
            let high_pass = ctx.create_biquad_filter()?;
            high_pass.set_type(BiquadFilterType::Highpass);
            high_pass.frequency().set_value(100.0);
            let tap = AudioWorkletNode::new(&ctx, "mic-tap")?;
            source.connect_with_audio_node(&high_pass)?;
            high_pass.connect_with_audio_node(&tap)?;
            // The tap writes no output, so this is silent; it keeps the node pulled.
            tap.connect_with_audio_node(&ctx.destination())?;
            if let Ok(p) = ctx.resume() {
                let _ = JsFuture::from(p).await;
            }
            Ok::<_, JsValue>(tap)
        }
        .await;
        if rest.is_err() {
            let _ = close_on_err.close();
        }
        rest.map(|tap| (ctx, tap))
    }
    .await;
    let (ctx, tap) = match built {
        Ok(v) => v,
        Err(_) => {
            for track in stream.get_tracks().iter() {
                track.unchecked_into::<web_sys::MediaStreamTrack>().stop();
            }
            return Err("Couldn't start the mic.".into());
        }
    };

    let samples = Rc::new(RefCell::new(Vec::<f32>::with_capacity(
        SAMPLE_RATE as usize * 30,
    )));
    let sink = samples.clone();
    let mut vad = Vad::with_silence(silence_ms);
    let mut done = false;
    let on_frame = Closure::<dyn FnMut(MessageEvent)>::new(move |e: MessageEvent| {
        if done {
            return;
        }
        let frame = Float32Array::new(&e.data()).to_vec();
        let event = vad.push(&frame);
        let len = {
            let mut s = sink.borrow_mut();
            s.extend_from_slice(&frame);
            s.len()
        };
        on_heard(Heard::Frame {
            ms: (len / (SAMPLE_RATE as usize / 1000)) as u32,
            speaking: vad.speaking(),
        });
        if event == VadEvent::SilenceTimeout || len >= MAX_SAMPLES {
            done = true;
            on_heard(Heard::Done);
        }
    });
    tap.port()
        .map_err(|_| "port")?
        .set_onmessage(Some(on_frame.as_ref().unchecked_ref()));
    debug_assert_eq!(FRAME, 480, "mic-worklet.js posts 480-sample frames");
    Ok(Recorder {
        stream,
        ctx,
        tap,
        samples,
        _on_frame: on_frame,
    })
}

/// The WAV, transcribed by Groq Whisper. One retry on a network error or a 5xx.
pub async fn transcribe(key: &str, wav: &[u8]) -> Result<String, String> {
    let mut last = String::new();
    for _ in 0..2 {
        match transcribe_once(key, wav).await {
            Ok(text) => return Ok(text),
            Err((msg, retry)) => {
                last = msg;
                if !retry {
                    break;
                }
            }
        }
    }
    Err(last)
}

/// Err((message, worth retrying)).
async fn transcribe_once(key: &str, wav: &[u8]) -> Result<String, (String, bool)> {
    let unreachable = || {
        (
            "Couldn't reach Groq. Your recording is kept: try again.".to_string(),
            true,
        )
    };
    let fail = |m: &str| (m.to_string(), false);

    let bytes = Uint8Array::from(wav);
    let props = web_sys::BlobPropertyBag::new();
    props.set_type("audio/wav");
    let blob = web_sys::Blob::new_with_u8_array_sequence_and_options(&Array::of1(&bytes), &props)
        .map_err(|_| fail("blob"))?;
    let form = web_sys::FormData::new().map_err(|_| fail("form"))?;
    form.append_with_blob_and_filename("file", &blob, "dump.wav")
        .map_err(|_| fail("form"))?;
    for (k, v) in [
        ("model", GROQ_MODEL),
        ("language", "en"),
        ("temperature", "0"),
        ("response_format", "json"),
    ] {
        form.append_with_str(k, v).map_err(|_| fail("form"))?;
    }

    let controller = web_sys::AbortController::new().map_err(|_| fail("abort"))?;
    let init = to_js(
        &json!({ "method": "POST", "headers": { "Authorization": format!("Bearer {key}") } }),
    )
    .map_err(|_| fail("init"))?;
    Reflect::set(&init, &"body".into(), &form).map_err(|_| fail("init"))?;
    Reflect::set(&init, &"signal".into(), &controller.signal()).map_err(|_| fail("init"))?;
    let abort = controller.clone();
    let cb = Closure::once_into_js(move || abort.abort());
    let window = web_sys::window().ok_or_else(|| fail("window"))?;
    let timer = window
        .set_timeout_with_callback_and_timeout_and_arguments_0(cb.unchecked_ref(), GROQ_TIMEOUT_MS)
        .unwrap_or(0);

    let result = async {
        let res: web_sys::Response =
            JsFuture::from(chrome::fetch(GROQ_TRANSCRIBE_URL, &init).map_err(|_| unreachable())?)
                .await
                .map_err(|_| unreachable())?
                .unchecked_into();
        if !res.ok() {
            return Err(match groq_error(res.status()) {
                Some(m) => fail(m),
                None => unreachable(),
            });
        }
        let body = JsFuture::from(res.text().map_err(|_| unreachable())?)
            .await
            .map_err(|_| unreachable())?;
        parse_groq_reply(&body.as_string().unwrap_or_default())
            .ok_or_else(|| fail("Groq sent a reply we couldn't read."))
    }
    .await;
    window.clear_timeout_with_handle(timer);
    result
}

/// One chunk of speech from Groq Orpheus, as WAV bytes. A network error is
/// worth a short wait and another try, like a 5xx. With `cached`, words
/// already spoken in this voice come from crate::cache; the Settings voice
/// test passes false, since it is there to try the key.
pub async fn synthesize(
    provider: TtsProvider,
    key: &str,
    voice: &str,
    text: &str,
    signal: &web_sys::AbortSignal,
    cached: bool,
) -> Result<js_sys::ArrayBuffer, TtsFailure> {
    use reader_core::voice_agent::{tts_body, tts_failure};
    let unreachable = |_| TtsFailure::Wait { secs: 2 };
    let body = tts_body(provider, text, voice).to_string();
    // The same words in the same voice are the same audio: say them from the cache.
    let cache_key = crate::cache::key(provider.url(), &body);
    if cached {
        if let Some(wav) = crate::cache::SPEECH.get_bytes(&cache_key).await {
            return Ok(wav);
        }
    }
    let init = to_js(&json!({
        "method": "POST",
        "headers": { "Authorization": format!("Bearer {key}"), "content-type": "application/json" },
        "body": body,
    }))
    .map_err(|_| TtsFailure::Stop("Couldn't build the speech request."))?;
    Reflect::set(&init, &"signal".into(), signal)
        .map_err(|_| TtsFailure::Stop("Couldn't build the speech request."))?;
    let res: web_sys::Response =
        JsFuture::from(chrome::fetch(provider.url(), &init).map_err(unreachable)?)
            .await
            .map_err(unreachable)?
            .unchecked_into();
    if !res.ok() {
        let retry_after = res.headers().get("retry-after").ok().flatten();
        let body = match res.text() {
            Ok(p) => JsFuture::from(p).await.ok().and_then(|b| b.as_string()),
            Err(_) => None,
        };
        return Err(tts_failure(
            provider,
            res.status(),
            &body.unwrap_or_default(),
            retry_after.as_deref(),
        ));
    }
    let wav: js_sys::ArrayBuffer = JsFuture::from(res.array_buffer().map_err(unreachable)?)
        .await
        .map_err(unreachable)?
        .unchecked_into();
    // Before the player decodes (and detaches) it.
    if cached {
        crate::cache::SPEECH.put_bytes(&cache_key, &wav).await;
    }
    Ok(wav)
}

/// A failed speech request, in words for the page.
pub fn failure_text(f: &TtsFailure) -> String {
    match f {
        TtsFailure::Stop(m) => m.to_string(),
        TtsFailure::Wait { secs } => format!("Groq is busy. Try again in {secs} s."),
    }
}

/// Speech chunks played back to back, gapless, in the order queued.
/// `stop` cuts it off at once and keeps the output open: a context made
/// later, away from a click, may start suspended and play nothing.
#[derive(Clone, Default)]
pub struct Player(Rc<RefCell<PlayerState>>);

#[derive(Default)]
struct PlayerState {
    ctx: Option<AudioContext>,
    sources: Vec<web_sys::AudioBufferSourceNode>,
    /// When the last queued chunk ends, in the context's clock.
    ends_at: f64,
    /// Bumped by `stop`, so a chunk still decoding then is dropped.
    epoch: u64,
    /// Held by `pause`: queueing more must not start it again.
    paused: bool,
}

impl Player {
    /// Create the output now, from a click, so autoplay rules allow it.
    pub fn open(&self) -> Result<AudioContext, JsValue> {
        let mut s = self.0.borrow_mut();
        let c = match &s.ctx {
            Some(c) => c.clone(),
            None => {
                let c = AudioContext::new()?;
                s.ctx = Some(c.clone());
                c
            }
        };
        if !s.paused {
            let _ = c.resume();
        }
        Ok(c)
    }

    /// Plays `wav` after everything already queued. `Some(ms)`: it starts in
    /// that many ms of playback; `None`: dropped (stopped meanwhile, or silent).
    /// `Some((ms until it starts, ms it lasts))`, or `None` if stopped meanwhile.
    pub async fn queue(&self, wav: js_sys::ArrayBuffer) -> Result<Option<(i32, i32)>, JsValue> {
        let ctx = self.open()?;
        let epoch = self.0.borrow().epoch;
        let buf: AudioBuffer = JsFuture::from(ctx.decode_audio_data(&wav)?)
            .await?
            .unchecked_into();
        if self.0.borrow().epoch != epoch {
            return Ok(None);
        }
        // Orpheus clips are mono; cut their dead air before they play.
        let rate = buf.sample_rate();
        let speech = reader_core::voice_agent::tighten(&buf.get_channel_data(0)?, rate as u32);
        if speech.is_empty() {
            return Ok(None);
        }
        let buf = ctx.create_buffer(1, speech.len() as u32, rate)?;
        buf.copy_to_channel(&speech, 0)?;
        let src = ctx.create_buffer_source()?;
        src.set_buffer(Some(&buf));
        src.connect_with_audio_node(&ctx.destination())?;
        let mut s = self.0.borrow_mut();
        let now = ctx.current_time();
        if s.ends_at <= now {
            // Everything queued before has played.
            s.sources.clear();
        }
        let at = s.ends_at.max(now);
        src.start_with_when(at)?;
        s.ends_at = at + buf.duration();
        s.sources.push(src);
        Ok(Some((
            ((at - now) * 1000.0) as i32,
            (buf.duration() * 1000.0) as i32,
        )))
    }

    /// Holds playback where it is; `resume` carries on from there.
    pub fn pause(&self) {
        let mut s = self.0.borrow_mut();
        s.paused = true;
        if let Some(c) = &s.ctx {
            let _ = c.suspend();
        }
    }

    pub fn resume(&self) {
        let mut s = self.0.borrow_mut();
        s.paused = false;
        if let Some(c) = &s.ctx {
            let _ = c.resume();
        }
    }

    /// Milliseconds of queued speech still to play.
    /// The output's clock in ms; it stands still while paused.
    pub fn now_ms(&self) -> f64 {
        self.0
            .borrow()
            .ctx
            .as_ref()
            .map_or(0.0, |c| c.current_time() * 1000.0)
    }

    pub fn remaining_ms(&self) -> i32 {
        let s = self.0.borrow();
        s.ctx.as_ref().map_or(0, |c| {
            ((s.ends_at - c.current_time()).max(0.0) * 1000.0) as i32
        })
    }

    /// Silence now; the output stays open for the next reply.
    pub fn stop(&self) {
        let mut s = self.0.borrow_mut();
        for src in s.sources.drain(..) {
            #[allow(deprecated)]
            let _ = src.stop();
        }
        s.ends_at = 0.0;
        s.epoch += 1;
        drop(s);
        self.resume();
    }

    /// Stop and let the output go (the page is leaving).
    pub fn close(&self) {
        self.stop();
        if let Some(c) = self.0.borrow_mut().ctx.take() {
            let _ = c.close();
        }
    }
}

/// What a `Speaker` tells its panel.
pub enum SpeakerEvent {
    /// A chunk was queued: its tag, its text, the ms of playback before it
    /// starts, and how long it lasts.
    Queued {
        tag: u32,
        line: String,
        delay_ms: i32,
        dur_ms: i32,
    },
    /// The provider asked for a pause: `Some(secs)`, then `None` when sending again.
    Waiting(Option<u32>),
    /// Groq gave up for good and OpenAI takes over from here; the reason, in words.
    Switched(String),
    /// Something went wrong, in words. With `failed()`, nothing more will be spoken.
    Error(String),
}

/// The speech keys a `Speaker` may use.
#[derive(Clone, Default)]
pub struct SpeechKeys {
    pub groq: String,
    pub openai: String,
}

impl SpeechKeys {
    pub fn any(&self) -> bool {
        !self.groq.is_empty() || !self.openai.is_empty()
    }
}

/// Text in, speech out, in order: each chunk goes to the speech provider and
/// then onto the player, one at a time, while more text keeps arriving. Each
/// chunk carries a tag (the audiobook's page) that comes back when queued.
/// Groq speaks first; when it stops for good (its daily limit, a bad key) and
/// there is an OpenAI key, OpenAI takes over for the rest of the session and
/// the chunk Groq refused is sent again, so nothing is skipped.
#[derive(Clone)]
pub struct Speaker(Rc<SpeakerInner>);

struct SpeakerInner {
    keys: SpeechKeys,
    voice: String,
    provider: std::cell::Cell<TtsProvider>,
    signal: web_sys::AbortSignal,
    player: Player,
    lines: RefCell<std::collections::VecDeque<(String, u32)>>,
    draining: std::cell::Cell<bool>,
    /// False once whoever started this has moved on: stop speaking.
    live: Box<dyn Fn() -> bool>,
    on_event: Box<dyn Fn(SpeakerEvent)>,
    /// Gave up (no provider left): nothing more will be spoken.
    failed: std::cell::Cell<bool>,
}

impl Speaker {
    pub fn new(
        keys: SpeechKeys,
        voice: String,
        signal: web_sys::AbortSignal,
        player: Player,
        live: impl Fn() -> bool + 'static,
        on_event: impl Fn(SpeakerEvent) + 'static,
    ) -> Self {
        let first = if keys.groq.is_empty() {
            TtsProvider::OpenAi
        } else {
            TtsProvider::Groq
        };
        Self(Rc::new(SpeakerInner {
            keys,
            voice,
            provider: std::cell::Cell::new(first),
            signal,
            player,
            lines: RefCell::default(),
            draining: Default::default(),
            live: Box::new(live),
            on_event: Box::new(on_event),
            failed: Default::default(),
        }))
    }

    /// The longest chunk the current provider takes.
    pub fn max_chars(&self) -> usize {
        self.0.provider.get().max_chars()
    }

    pub fn say(&self, chunks: Vec<String>, tag: u32) {
        if chunks.is_empty() || self.failed() {
            return;
        }
        self.0
            .lines
            .borrow_mut()
            .extend(chunks.into_iter().map(|c| (c, tag)));
        if self.0.draining.replace(true) {
            return;
        }
        let me = self.0.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let emit = |e| {
                if (me.live)() {
                    (me.on_event)(e)
                }
            };
            'lines: loop {
                let next = me.lines.borrow_mut().pop_front();
                let Some((line, tag)) = next else { break };
                // Waits are taken on the provider's word, a few times per chunk,
                // and the same chunk goes again: a rate limit never drops words.
                let mut waits = 0;
                let wav = loop {
                    let provider = me.provider.get();
                    let key = match provider {
                        TtsProvider::Groq => &me.keys.groq,
                        TtsProvider::OpenAi => &me.keys.openai,
                    };
                    match synthesize(provider, key, &me.voice, &line, &me.signal, true).await {
                        Ok(wav) => break wav,
                        Err(TtsFailure::Wait { secs })
                            if waits < 4 && secs <= MAX_RETRY_WAIT_SECS =>
                        {
                            waits += 1;
                            emit(SpeakerEvent::Waiting(Some(secs)));
                            for _ in 0..secs * 4 {
                                if !(me.live)() {
                                    break 'lines;
                                }
                                sleep_ms(250).await;
                            }
                            emit(SpeakerEvent::Waiting(None));
                        }
                        Err(f) => match fallback(provider, !me.keys.openai.is_empty()) {
                            Some(next) => {
                                me.provider.set(next);
                                waits = 0;
                                emit(SpeakerEvent::Switched(format!(
                                    "Switched to {}'s voice: {}",
                                    next.name(),
                                    failure_text(&f)
                                )));
                            }
                            None => {
                                emit(SpeakerEvent::Error(failure_text(&f)));
                                me.failed.set(true);
                                break 'lines;
                            }
                        },
                    }
                };
                if !(me.live)() {
                    break;
                }
                match me.player.queue(wav).await {
                    Ok(Some((delay_ms, dur_ms))) => emit(SpeakerEvent::Queued {
                        tag,
                        line,
                        delay_ms,
                        dur_ms,
                    }),
                    Ok(None) => {}
                    Err(_) => emit(SpeakerEvent::Error("Couldn't play the voice.".into())),
                }
            }
            me.lines.borrow_mut().clear();
            me.draining.set(false);
        });
    }

    /// Text still waiting for, or being turned into, speech.
    pub fn busy(&self) -> bool {
        self.0.draining.get()
    }

    /// It gave up; nothing more will be spoken.
    pub fn failed(&self) -> bool {
        self.0.failed.get()
    }
}

/// Wait without blocking the page.
pub async fn sleep_ms(ms: i32) {
    // Works in the service worker too (no window there).
    let p = js_sys::Promise::new(&mut |resolve, _| {
        crate::claude::gloo_timeout(ms, move || {
            let _ = resolve.call0(&wasm_bindgen::JsValue::NULL);
        });
    });
    let _ = JsFuture::from(p).await;
}

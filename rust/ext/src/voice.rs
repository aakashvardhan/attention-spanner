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
use serde_json::json;
use std::cell::RefCell;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AudioContext, AudioContextOptions, AudioWorkletNode, BiquadFilterType, MediaStream,
    MessageEvent,
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
fn mic_error(e: &JsValue) -> String {
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
pub async fn start(mut on_heard: impl FnMut(Heard) + 'static) -> Result<Recorder, String> {
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
    let mut vad = Vad::new();
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

//! "Talk it through": a spoken Socratic tutor that asks about the paper and
//! explains only after repeated misses or "just tell me". Groq Whisper hears your turn, Haiku writes the reply as it
//! streams, and each finished sentence goes straight to Groq Orpheus, so the
//! voice starts before the reply is done. Cut in stops it. A turn can be
//! typed instead of spoken; a conversation begun by typing never opens the mic.

use crate::pages::use_settings;
use crate::voice::{self, sleep_ms, Heard, Player, Recorder, Speaker, SpeakerEvent, SpeechKeys};
use crate::{claude, gemini};
use leptos::prelude::*;
use reader_core::constants::CLAUDE_MODEL_QUICK;
use reader_core::voice::{clean_transcript, encode_wav, trim_to_speech};
use reader_core::voice_agent::{
    agent_system, paper_document, turn_prompt, Chunker, Source, Turn, TURN_SILENCE_MS,
};
use reader_core::youtube;
use std::rc::Rc;

const REPLY_TIMEOUT_MS: i32 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Off,
    Listening,
    /// Your words are with Whisper.
    Writing,
    Thinking,
    Speaking,
}

#[component]
pub fn TalkPanel(
    title: Signal<String>,
    source: Source,
    page_texts: Signal<Option<Vec<String>>>,
    page: Signal<u32>,
    on_close: Callback<()>,
) -> impl IntoView {
    let (settings, _) = use_settings();
    // Who thinks: Gemini on a video, Haiku otherwise.
    let brain_key = move |s: &reader_core::types::Settings| {
        if source == Source::Video {
            s.gemini_key.clone()
        } else {
            s.claude_key.clone()
        }
    };
    let brain_name = move || {
        if source == Source::Video {
            "Gemini"
        } else {
            "Claude"
        }
    };
    let phase = RwSignal::new(Phase::Off);
    let hearing = RwSignal::new(false);
    let error = RwSignal::new(String::new());
    // Groq asked for a pause before the next sentence (its per-minute limit).
    let waiting = RwSignal::new(None::<u32>);
    // Which voice took over, and why (Groq's daily limit).
    let notice = RwSignal::new(String::new());
    let turns = RwSignal::new(Vec::<Turn>::new());
    // Start talking turns the mic on for your turns; a typed turn does not.
    let voice_on = RwSignal::new(false);
    let draft = RwSignal::new(String::new());
    let recorder = StoredValue::new_local(None::<Recorder>);
    let player = StoredValue::new_local(Player::default());
    let reply_ctl = StoredValue::new_local(None::<web_sys::AbortController>);
    // Bumped on every new reply and every interruption; a stale reply stops itself.
    let generation = StoredValue::new(0u64);

    // One recording per turn, and only while it is your turn: the mic is off
    // while it thinks and speaks, so its own voice never cuts it off or gets
    // transcribed as yours. Cut in interrupts it.
    let listen = StoredValue::new_local(None::<Rc<dyn Fn()>>);
    let start_listening = move || {
        if let Some(f) = listen.get_value() {
            f();
        }
    };

    let interrupt = move || {
        generation.update_value(|g| *g += 1);
        if let Some(c) = reply_ctl.try_update_value(Option::take).flatten() {
            c.abort();
        }
        player.with_value(Player::stop);
        // A reply cut off before its first word leaves no empty line behind.
        turns.update(|t| {
            if t.last().is_some_and(|l| l.agent && l.text.is_empty()) {
                t.pop();
            }
        });
    };

    let stop_all = move || {
        interrupt();
        recorder.try_update_value(Option::take);
        phase.set(Phase::Off);
        voice_on.set(false);
        hearing.set(false);
    };
    on_cleanup(move || {
        stop_all();
        player.with_value(Player::close);
    });

    // Haiku's reply, shown and spoken sentence by sentence as it streams;
    // your turn starts when the last sentence has played.
    let reply = move || {
        let s = settings.get_untracked();
        let (claude_key, gemini_key, voice_id) = (s.claude_key, s.gemini_key, s.talk_voice);
        let keys = SpeechKeys {
            groq: s.groq_key,
            openai: s.openai_key,
        };
        // Typed with no speech key: the reply is only written.
        let speak = keys.any();
        generation.update_value(|g| *g += 1);
        let mine = generation.get_value();
        let Ok(ctl) = web_sys::AbortController::new() else {
            return;
        };
        reply_ctl.set_value(Some(ctl.clone()));
        phase.set(Phase::Thinking);
        let doc =
            page_texts.with_untracked(|p| paper_document(p.as_deref().unwrap_or_default(), source));
        let prompt = turn_prompt(&turns.get_untracked(), page.get_untracked(), source);
        let system = agent_system(&title.get_untracked(), source);
        let live = move || generation.try_get_value() == Some(mine);
        turns.update(|t| {
            t.push(Turn {
                agent: true,
                text: String::new(),
            })
        });
        let show = move |text: &str| {
            if live() {
                turns.update(|t| {
                    if let Some(last) = t.last_mut().filter(|l| l.agent) {
                        last.text = text.trim().to_string();
                    }
                });
            }
        };

        let speaker = Speaker::new(
            keys,
            voice_id,
            ctl.signal(),
            player.get_value(),
            live,
            move |e| match e {
                SpeakerEvent::Queued { .. } => phase.set(Phase::Speaking),
                SpeakerEvent::Waiting(w) => waiting.set(w),
                SpeakerEvent::Switched(m) => notice.set(m),
                SpeakerEvent::Error(m) => error.set(m),
            },
        );

        leptos::task::spawn_local(async move {
            let mut chunker = Chunker::with_max(speaker.max_chars());
            let push = |chunks: Vec<String>| {
                if speak {
                    speaker.say(chunks, 0)
                }
            };
            // On a video Gemini thinks (whole reply, then spoken); else Haiku, streamed.
            let said = if source == Source::Video {
                let body = youtube::talk_request(&system, &doc, &prompt);
                gemini::generate(&gemini_key, &body, REPLY_TIMEOUT_MS, Some(ctl))
                    .await
                    .and_then(|b| youtube::parse_reply(&b))
            } else {
                let ask = claude::Ask {
                    api_key: &claude_key,
                    model: CLAUDE_MODEL_QUICK,
                    system: &system,
                    document: &doc,
                    prompt: &prompt,
                    cache: true,
                    timeout_ms: REPLY_TIMEOUT_MS,
                    controller: Some(ctl),
                    image_jpeg: None,
                    remember: false,
                };
                claude::stream(ask, |so_far| {
                    show(so_far);
                    push(chunker.take(so_far, false));
                })
                .await
            };
            if !live() {
                return;
            }
            match said {
                Ok(text) => {
                    show(&text);
                    push(chunker.take(&text, true));
                }
                Err(m) => {
                    error.set(m);
                    turns.update(|t| {
                        if t.last().is_some_and(|l| l.agent && l.text.is_empty()) {
                            t.pop();
                        }
                    });
                }
            }
            // ponytail: polls the queue; an `onended` on the last source if this ever lags.
            while live() && (speaker.busy() || player.with_value(Player::remaining_ms) > 0) {
                sleep_ms(150).await;
            }
            if live() && phase.get_untracked() != Phase::Off {
                if voice_on.get_untracked() {
                    phase.set(Phase::Listening);
                    start_listening();
                } else {
                    phase.set(Phase::Off);
                }
            }
        });
    };

    listen.set_value(Some(Rc::new(move || {
        if recorder.with_value(Option::is_some) {
            return;
        }
        leptos::task::spawn_local(async move {
            let started = voice::start(TURN_SILENCE_MS, move |h| match h {
                Heard::Frame { speaking, .. } => {
                    if hearing.get_untracked() != speaking {
                        hearing.set(speaking);
                    }
                }
                // Not from inside the recorder's own callback: taking it drops it.
                Heard::Done => leptos::task::spawn_local(async move {
                    end_turn(
                        recorder,
                        phase,
                        hearing,
                        error,
                        turns,
                        settings,
                        reply,
                        start_listening,
                    )
                    .await
                }),
            })
            .await;
            match started {
                Ok(rec) if phase.try_get_untracked() == Some(Phase::Listening) => {
                    recorder.set_value(Some(rec))
                }
                Ok(_) => {}
                // The panel closed while the mic was asked for: nothing left to tell.
                Err(_) if phase.try_get_untracked().is_none() => {}
                Err(m) => {
                    error.set(m);
                    stop_all();
                }
            }
        });
    })));

    let cut_in = move || {
        interrupt();
        phase.set(Phase::Listening);
        start_listening();
    };

    let toggle = move || {
        if phase.get_untracked() != Phase::Off {
            stop_all();
            return;
        }
        let s = settings.get_untracked();
        if brain_key(&s).is_empty() || s.groq_key.is_empty() {
            error.set(format!(
                "Talking needs a {} key and a Groq key in Settings.",
                brain_name()
            ));
            return;
        }
        error.set(String::new());
        // From the click, so the browser lets it play.
        if player.with_value(Player::open).is_err() {
            error.set("Couldn't open the speakers.".into());
            return;
        }
        voice_on.set(true);
        if turns.with_untracked(Vec::is_empty) {
            // It opens the conversation; your turn follows.
            reply();
        } else {
            phase.set(Phase::Listening);
            start_listening();
        }
    };

    // A typed turn: it stands in for this spoken one (whatever the mic caught
    // is dropped) and cuts off a reply in progress.
    let send = move || {
        let text = draft.get_untracked().trim().to_string();
        if text.is_empty() {
            return;
        }
        let s = settings.get_untracked();
        if brain_key(&s).is_empty() {
            error.set(format!("Typing needs a {} key in Settings.", brain_name()));
            return;
        }
        error.set(String::new());
        interrupt();
        recorder.try_update_value(Option::take);
        hearing.set(false);
        // From the keypress, so the browser lets the reply play.
        let _ = player.with_value(Player::open);
        turns.update(|t| t.push(Turn { agent: false, text }));
        draft.set(String::new());
        reply();
    };

    let status = move || match phase.get() {
        Phase::Off => "Off",
        Phase::Listening if hearing.get() => "Hearing you…",
        Phase::Listening => "Your turn",
        Phase::Writing => "Writing down what you said…",
        Phase::Thinking => "Thinking…",
        Phase::Speaking => "Speaking",
    };

    view! {
        <section class="reader-notes reader-talk" aria-labelledby="talk-heading" on:keydown=move |e: web_sys::KeyboardEvent| {
            if e.key() == "Escape" { on_close.run(()); }
        }>
            <h2 id="talk-heading">"Talk it through"</h2>
            <p class="reader-explain-lede">{match source {
                Source::Paper => "Say what you think the paper is doing. It tutors by asking; say \"just tell me\" for a straight answer. It listens when it has finished speaking. Can't talk right now? Type instead.",
                Source::Webpage => "Say what you think the page is saying. It tutors by asking; say \"just tell me\" for a straight answer. It listens when it has finished speaking. Can't talk right now? Type instead.",
                Source::Video => "Say what you took from the video so far. It tutors by asking; say \"just tell me\" for a straight answer. It listens when it has finished speaking. Can't talk right now? Type instead.",
            }}</p>
            <button type="button" class="fc-primary-btn" aria-pressed=move || (phase.get() != Phase::Off).to_string() on:click=move |_| toggle()>
                {move || if phase.get() == Phase::Off { "Start talking" } else { "Stop" }}
            </button>
            <Show when=move || matches!(phase.get(), Phase::Thinking | Phase::Speaking)>
                <button type="button" class="ghost-btn" on:click=move |_| cut_in()>"Cut in"</button>
            </Show>
            // One large sign of whose turn it is; the words beside it say the same for a screen reader.
            <span class="talk-orb" aria-hidden="true" data-state=move || match phase.get() {
                Phase::Off => "off",
                Phase::Listening if hearing.get() => "hearing",
                Phase::Listening => "listening",
                Phase::Writing | Phase::Thinking => "thinking",
                Phase::Speaking => "speaking",
            }></span>
            <p class="define-label" role="status" aria-live="polite" data-phase=move || format!("{:?}", phase.get()).to_lowercase()>{status}</p>
            <Show when=move || notice.with(|n| !n.is_empty())>
                <p class="define-label" role="status">{move || notice.get()}</p>
            </Show>
            {move || waiting.get().map(|s| view! { <p class="define-label" role="status">{format!("Groq's per-minute limit: carrying on in {s} s…")}</p> })}
            <Show when=move || error.with(|e| !e.is_empty())>
                <p class="ai-note-error" role="alert">{move || error.get()}</p>
            </Show>
            <form class="reader-talk-type" on:submit=move |e: web_sys::SubmitEvent| { e.prevent_default(); send(); }>
                <label class="define-label" for="talk-type">"Or type it"</label>
                <textarea id="talk-type" class="answer-input" rows="2" placeholder="What you'd have said…" prop:value=move || draft.get() on:input=move |e| draft.set(event_target_value(&e)) on:keydown=move |e: web_sys::KeyboardEvent| {
                    // Enter sends, Shift+Enter starts a new line.
                    if e.key() == "Enter" && !e.shift_key() && !e.is_composing() { e.prevent_default(); send(); }
                }></textarea>
                <button type="submit" class="fc-primary-btn" disabled=move || draft.with(|d| d.trim().is_empty())>"Send"</button>
            </form>
            <ol class="reader-talk-turns">
                {move || turns.get().into_iter().map(|t| view! {
                    <li data-who=if t.agent { "agent" } else { "you" }>
                        <strong>{if t.agent { "It asked" } else { "You" }}</strong>
                        <p>{if t.text.is_empty() { "…".to_string() } else { t.text }}</p>
                    </li>
                }).collect_view()}
            </ol>
        </section>
    }
}

/// Your turn ended: the mic goes off, Whisper writes it down, Haiku replies.
/// Nothing heard, or nothing understood, and it is still your turn.
#[allow(clippy::too_many_arguments)]
async fn end_turn(
    recorder: StoredValue<Option<Recorder>, LocalStorage>,
    phase: RwSignal<Phase>,
    hearing: RwSignal<bool>,
    error: RwSignal<String>,
    turns: RwSignal<Vec<Turn>>,
    settings: Signal<reader_core::types::Settings>,
    reply: impl Fn() + 'static,
    start_listening: impl Fn() + 'static,
) {
    let Some(rec) = recorder.try_update_value(Option::take).flatten() else {
        return;
    };
    hearing.set(false);
    let speech = trim_to_speech(&rec.finish());
    if phase.get_untracked() != Phase::Listening {
        return;
    }
    if speech.is_empty() {
        start_listening();
        return;
    }
    phase.set(Phase::Writing);
    let key = settings.get_untracked().groq_key;
    let heard = voice::transcribe(&key, &encode_wav(&speech)).await;
    // Stopped, or the panel closed, meanwhile.
    if phase.try_get_untracked() != Some(Phase::Writing) {
        return;
    }
    match heard.map(|raw| clean_transcript(&raw)) {
        Ok(said) if !said.is_empty() => {
            turns.update(|t| {
                t.push(Turn {
                    agent: false,
                    text: said,
                })
            });
            reply();
        }
        other => {
            if let Err(m) = other {
                error.set(m);
            }
            phase.set(Phase::Listening);
            start_listening();
        }
    }
}

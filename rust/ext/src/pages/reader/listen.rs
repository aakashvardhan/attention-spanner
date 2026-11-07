//! Listen: the paper read aloud from the page you are on, as narration.
//! Haiku turns each page into something to hear (equations explained, not
//! recited; citations and page furniture dropped), Orpheus speaks it. The
//! next page is prepared while this one plays, a few seconds ahead only.

use crate::claude;
use crate::pages::use_settings;
use crate::voice::{sleep_ms, Player, Speaker, SpeakerEvent, SpeechKeys};
use leptos::prelude::*;
use reader_core::audiobook::{is_skip, narrate_prompt, narrate_system, page_document};
use reader_core::constants::CLAUDE_MODEL_QUICK;
use reader_core::voice_agent::{sentence_at, Chunker, Source};

/// The next page's narration starts once less than this is left to play.
const LOOKAHEAD_MS: i32 = 8_000;
const PAGE_TIMEOUT_MS: i32 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Off,
    Playing,
    Paused,
    Done,
}

#[component]
pub fn ListenPanel(
    title: Signal<String>,
    /// The open PDF: each page goes to Haiku as a picture too, for its math.
    doc: StoredValue<wasm_bindgen::JsValue, LocalStorage>,
    page_texts: Signal<Option<Vec<String>>>,
    /// Where the reader is now: listening starts here.
    page: Signal<u32>,
    on_jump: Callback<u32>,
    on_close: Callback<()>,
) -> impl IntoView {
    let (settings, _) = use_settings();
    let phase = RwSignal::new(Phase::Off);
    let error = RwSignal::new(String::new());
    // Groq asked for a pause before the next chunk (its per-minute limit).
    let waiting = RwSignal::new(None::<u32>);
    // Which voice took over, and why (Groq's daily limit).
    let notice = RwSignal::new(String::new());
    // The page being heard, and what is being said for each page so far.
    let hearing = RwSignal::new(None::<u32>);
    let narration = RwSignal::new(Vec::<(u32, String)>::new());
    let follow = RwSignal::new(true);
    // The sentence playing now, highlighted in the narration.
    let spoken = RwSignal::new(None::<String>);
    // What is queued to play: (page, starts, ends on the output's clock, text).
    let timeline = StoredValue::new(Vec::<(u32, f64, f64, String)>::new());
    let panel = NodeRef::<leptos::html::Section>::new();
    let player = StoredValue::new_local(Player::default());
    let ctl = StoredValue::new_local(None::<web_sys::AbortController>);
    let generation = StoredValue::new(0u64);

    let stop = move || {
        generation.update_value(|g| *g += 1);
        if let Some(c) = ctl.try_update_value(Option::take).flatten() {
            c.abort();
        }
        player.with_value(Player::stop);
    };
    on_cleanup(move || {
        stop();
        player.with_value(Player::close);
    });

    let play_from = move |from: u32| {
        stop();
        let s = settings.get_untracked();
        let keys = SpeechKeys {
            groq: s.groq_key.clone(),
            openai: s.openai_key.clone(),
        };
        if s.claude_key.is_empty() || !keys.any() {
            error
                .set("Listening needs a Claude key, and a Groq or OpenAI key, in Settings.".into());
            return;
        }
        let Some(pages) = page_texts.get_untracked() else {
            error.set("The paper's text isn't ready yet.".into());
            return;
        };
        // From the click, so the browser lets it play.
        if player.with_value(Player::open).is_err() {
            error.set("Couldn't open the speakers.".into());
            return;
        }
        let Ok(controller) = web_sys::AbortController::new() else {
            return;
        };
        ctl.set_value(Some(controller.clone()));
        let mine = generation.get_value();
        let live = move || generation.try_get_value() == Some(mine);
        error.set(String::new());
        notice.set(String::new());
        narration.set(Vec::new());
        hearing.set(None);
        phase.set(Phase::Playing);

        spoken.set(None);
        timeline.set_value(Vec::new());

        // Follow the output's clock (it stops while paused): the page being
        // heard, and the sentence in it.
        leptos::task::spawn_local(async move {
            // Set when the sentence changes; the next tick, once it is drawn,
            // brings it into view.
            let mut scroll_due = false;
            loop {
                sleep_ms(150).await;
                if std::mem::take(&mut scroll_due) {
                    keep_in_view(panel);
                }
                if !live() || matches!(phase.get_untracked(), Phase::Off | Phase::Done) {
                    spoken.set(None);
                    return;
                }
                let now = player.with_value(Player::now_ms);
                timeline.update_value(|t| t.retain(|e| e.2 > now));
                let Some((page, frac, line)) = timeline.with_value(|t| {
                    t.first()
                        .filter(|e| e.1 <= now)
                        .map(|e| (e.0, (now - e.1) / (e.2 - e.1).max(1.0), e.3.clone()))
                }) else {
                    continue;
                };
                if hearing.get_untracked() != Some(page) {
                    hearing.set(Some(page));
                    if follow.get_untracked() {
                        on_jump.run(page);
                    }
                }
                let now_saying = sentence_at(&line, frac);
                if spoken.with_untracked(|s| s.as_deref() != Some(now_saying)) {
                    spoken.set(Some(now_saying.to_string()));
                    scroll_due = true;
                }
            }
        });
        let speaker = Speaker::new(
            keys,
            s.talk_voice.clone(),
            controller.signal(),
            player.get_value(),
            live,
            move |e| match e {
                SpeakerEvent::Queued {
                    tag,
                    line,
                    delay_ms,
                    dur_ms,
                } => {
                    let at = player.with_value(Player::now_ms) + f64::from(delay_ms);
                    timeline.update_value(|t| t.push((tag, at, at + f64::from(dur_ms), line)));
                }
                SpeakerEvent::Waiting(w) => waiting.set(w),
                SpeakerEvent::Switched(m) => notice.set(m),
                SpeakerEvent::Error(m) => error.set(m),
            },
        );
        let system = narrate_system(&title.get_untracked(), Source::Paper);
        let count = pages.len() as u32;

        leptos::task::spawn_local(async move {
            for p in from.max(1)..=count {
                // Stay only a little ahead of what is playing (paused, this waits).
                while live()
                    && (speaker.busy() || player.with_value(Player::remaining_ms) > LOOKAHEAD_MS)
                {
                    sleep_ms(250).await;
                }
                if !live() {
                    return;
                }
                // It gave up (the reason is on screen): no more pages to prepare.
                if speaker.failed() {
                    break;
                }
                let text = &pages[p as usize - 1];
                if text.trim().is_empty() {
                    continue;
                }
                let previous = (p > from).then(|| pages[p as usize - 2].as_str());
                let prompt = narrate_prompt(p, count, previous, Source::Paper);
                let doc_text = page_document(text);
                // ponytail: one render per page; a missing picture falls back to text alone.
                let image = crate::pdfjs::page_image(&doc.get_value(), p).await;
                if !live() {
                    return;
                }
                let mut chunker = Chunker::with_max(speaker.max_chars());
                let show = move |t: &str| {
                    narration.update(|n| match n.iter_mut().find(|(q, _)| *q == p) {
                        Some((_, said)) => *said = t.trim().to_string(),
                        None => n.push((p, t.trim().to_string())),
                    })
                };
                let ask = claude::Ask {
                    api_key: &s.claude_key,
                    model: CLAUDE_MODEL_QUICK,
                    system: &system,
                    document: &doc_text,
                    prompt: &prompt,
                    cache: false,
                    timeout_ms: PAGE_TIMEOUT_MS,
                    controller: Some(controller.clone()),
                    image_jpeg: image.as_deref(),
                    remember: true,
                };
                let said = claude::stream(ask, |so_far| {
                    if !is_skip(so_far) {
                        show(so_far);
                        speaker.say(chunker.take(so_far, false), p);
                    }
                })
                .await;
                if !live() {
                    return;
                }
                match said {
                    Ok(t) if !is_skip(&t) => {
                        show(&t);
                        speaker.say(chunker.take(&t, true), p);
                    }
                    Ok(_) => {}
                    Err(m) => {
                        error.set(m);
                        stop();
                        phase.set(Phase::Off);
                        return;
                    }
                }
            }
            // ponytail: polls the queue; an `onended` on the last source if this ever lags.
            while live() && (speaker.busy() || player.with_value(Player::remaining_ms) > 0) {
                sleep_ms(250).await;
            }
            if live() {
                waiting.set(None);
                phase.set(if speaker.failed() {
                    Phase::Off
                } else {
                    Phase::Done
                });
            }
        });
    };

    let pause_or_resume = move || match phase.get_untracked() {
        Phase::Playing => {
            player.with_value(Player::pause);
            phase.set(Phase::Paused);
        }
        Phase::Paused => {
            player.with_value(Player::resume);
            phase.set(Phase::Playing);
        }
        _ => {}
    };

    let status = move || match (phase.get(), hearing.get()) {
        (Phase::Off, _) => {
            "Reads the paper aloud from this page, explaining the math as it goes.".to_string()
        }
        (Phase::Done, _) => "That's the end of the paper.".to_string(),
        (Phase::Paused, Some(p)) => format!("Paused on page {p}"),
        (Phase::Paused, None) => "Paused".to_string(),
        (Phase::Playing, Some(p)) => format!("Reading page {p}"),
        (Phase::Playing, None) => "Getting the first page ready…".to_string(),
    };
    let current = move || {
        let p = hearing.get()?;
        narration.with(|n| n.iter().find(|(q, _)| *q == p).map(|(_, t)| t.clone()))
    };

    view! {
        <section node_ref=panel class="reader-notes reader-talk" aria-labelledby="listen-heading" on:keydown=move |e: web_sys::KeyboardEvent| {
            if e.key() == "Escape" { on_close.run(()); }
        }>
            // Pinned: the panel scrolls to follow the narration, the controls stay.
            <div class="listen-controls">
                <h2 id="listen-heading">"Listen"</h2>
                <p class="reader-explain-lede" role="status" aria-live="polite" data-phase=move || format!("{:?}", phase.get()).to_lowercase()>{status}</p>
                <div class="reader-question-actions">
                    {move || match phase.get() {
                        Phase::Off | Phase::Done => view! {
                            <button type="button" class="fc-primary-btn" on:click=move |_| play_from(page.get_untracked())>
                                {move || format!("Read from page {}", page.get())}
                            </button>
                        }.into_any(),
                        _ => view! {
                            <button type="button" class="fc-primary-btn" on:click=move |_| pause_or_resume()>
                                {move || if phase.get() == Phase::Paused { "Resume" } else { "Pause" }}
                            </button>
                            <button type="button" class="ghost-btn" on:click=move |_| { stop(); phase.set(Phase::Off); hearing.set(None); }>"Stop"</button>
                        }.into_any(),
                    }}
                </div>
                <label class="define-label">
                    <input type="checkbox" prop:checked=move || follow.get() on:change=move |e| follow.set(event_target_checked(&e)) />
                    " Turn pages as it reads"
                </label>
                <Show when=move || notice.with(|n| !n.is_empty())>
                    <p class="define-label" role="status">{move || notice.get()}</p>
                </Show>
                {move || waiting.get().map(|s| view! { <p class="define-label" role="status">{format!("Groq's per-minute limit: carrying on in {s} s…")}</p> })}
                <Show when=move || error.with(|e| !e.is_empty())>
                    <p class="ai-note-error" role="alert">{move || error.get()}</p>
                </Show>
            </div>
            {move || current().map(|t| {
                // The sentence being spoken, marked where it sits in the page's narration.
                let (before, now, after) = match spoken.get().and_then(|s| t.find(&s).map(|i| (i, s.len()))) {
                    Some((i, n)) => (t[..i].to_string(), t[i..i + n].to_string(), t[i + n..].to_string()),
                    None => (t, String::new(), String::new()),
                };
                view! {
                    <ol class="reader-talk-turns"><li data-who="agent"><strong>{move || hearing.get().map(|p| format!("Page {p}"))}</strong><p>
                        {before}
                        {(!now.is_empty()).then(|| view! { <mark class="listen-now">{now}</mark> })}
                        {after}
                    </p></li></ol>
                }
            })}
        </section>
    }
}

/// Scrolls the panel only when the spoken sentence is out of its view, and
/// then to a third of the way down, so the next lines are visible too. If you
/// scroll away, it brings you back at the next sentence.
fn keep_in_view(panel: NodeRef<leptos::html::Section>) {
    let Some(el) = panel.get_untracked() else {
        return;
    };
    let Ok(Some(mark)) = el.query_selector("mark.listen-now") else {
        return;
    };
    let (box_, m) = (
        el.get_bounding_client_rect(),
        mark.get_bounding_client_rect(),
    );
    // The pinned controls cover the top of the panel: what is under them is hidden.
    let top = match el.query_selector(".listen-controls") {
        Ok(Some(c)) => c.get_bounding_client_rect().bottom(),
        _ => box_.top(),
    };
    if m.top() >= top && m.bottom() <= box_.bottom() {
        return;
    }
    let target = f64::from(el.scroll_top()) + m.top() - top - (box_.bottom() - top) / 3.0;
    let opts = web_sys::ScrollToOptions::new();
    opts.set_top(target.max(0.0));
    opts.set_behavior(if super::viewport::nav_smooth() {
        web_sys::ScrollBehavior::Smooth
    } else {
        web_sys::ScrollBehavior::Instant
    });
    el.scroll_to_with_scroll_to_options(&opts);
}

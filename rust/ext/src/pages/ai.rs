//! One AI answer's lifecycle, and how every answer renders
//! (src/shared/hooks/useAi.ts, components/AiNote.tsx, Markdown.tsx).

use crate::{chrome, claude, store};
use leptos::prelude::*;
use reader_core::ai::{cache_hit, cache_put, route, AiCache, AiRequest, Route};
use reader_core::markdown::{lift_math, render_markdown};
use reader_core::types::AiCacheEntry;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen(module = "/js/katex-bridge.mjs")]
extern "C" {
    #[wasm_bindgen(js_name = loadKatex)]
    fn load_katex() -> js_sys::Promise;
    #[wasm_bindgen(js_name = renderTex)]
    fn render_tex(tex: &str, display: bool) -> Option<String>;
}

/// A reader's question is short; past this the answer is not coming.
const ASK_TIMEOUT_MS: i32 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum AiStatus {
    Idle,
    Working,
    Streaming,
    Done,
    Error,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiView {
    pub status: AiStatus,
    pub text: String,
    pub model: String,
    /// Why this model, or "Saved answer"; the chip's tooltip
    pub reason: String,
    pub error: String,
}

impl Default for AiView {
    fn default() -> Self {
        Self {
            status: AiStatus::Idle,
            text: String::new(),
            model: String::new(),
            reason: String::new(),
            error: String::new(),
        }
    }
}

/// One answer at a time: a newer `start` supersedes an older one, and
/// unmounting aborts the stream, so a stale answer never lands in the wrong card.
#[derive(Clone, Copy)]
pub struct Ai {
    pub view: RwSignal<AiView>,
    generation: StoredValue<u64>,
    controller: StoredValue<Option<web_sys::AbortController>, LocalStorage>,
}

pub fn use_ai() -> Ai {
    let ai = Ai {
        view: RwSignal::new(AiView::default()),
        generation: StoredValue::new(0),
        controller: StoredValue::new_local(None),
    };
    on_cleanup(move || ai.abort());
    ai
}

impl Ai {
    fn abort(self) {
        if let Some(c) = self.controller.try_update_value(Option::take).flatten() {
            c.abort();
        }
    }

    /// Stop writing; what streamed so far stays.
    pub fn stop(self) {
        self.abort();
    }

    /// A saved answer if there is one, else Haiku, streamed.
    pub fn start(self, request: AiRequest) {
        self.generation.update_value(|g| *g += 1);
        let id = self.generation.get_value();
        // False once superseded, and once the owner is gone (the value is disposed).
        let current = move || self.generation.try_get_value() == Some(id);
        let show = move |v: AiView| {
            if current() {
                self.view.try_set(v);
            }
        };
        leptos::task::spawn_local(async move {
            let key = request
                .cache_key
                .as_ref()
                .map(|k| format!("{}:{k}", request.task.as_str()));
            if let Some(key) = &key {
                let cache: AiCache = store::get("aiCache").await.unwrap_or_default();
                if let Some(hit) = cache_hit(&cache, key) {
                    return show(AiView {
                        status: AiStatus::Done,
                        text: hit.text.clone(),
                        model: hit.model.clone(),
                        reason: "Saved answer".into(),
                        ..AiView::default()
                    });
                }
            }
            show(AiView {
                status: AiStatus::Working,
                ..AiView::default()
            });
            let settings = store::settings().await.unwrap_or_default();
            let online = window().navigator().on_line();
            let (model, reason) = match route(online, !settings.claude_key.is_empty()) {
                Route::None { reason } => {
                    return show(AiView {
                        status: AiStatus::Unavailable,
                        error: reason.into(),
                        ..AiView::default()
                    });
                }
                Route::Claude { model, reason } => (model, reason),
            };
            if !current() {
                return;
            }
            show(AiView {
                status: AiStatus::Working,
                model: model.into(),
                reason: reason.into(),
                ..AiView::default()
            });
            self.abort();
            let controller = web_sys::AbortController::new().ok();
            self.controller.set_value(controller.clone());
            let document = request.passages.join("\n\n");
            let reply = claude::stream(
                claude::Ask {
                    api_key: &settings.claude_key,
                    model,
                    system: &request.system,
                    document: &document,
                    prompt: &request.prompt,
                    cache: true,
                    timeout_ms: ASK_TIMEOUT_MS,
                    controller: controller.clone(),
                    image_jpeg: None,
                    remember: false,
                },
                |text| {
                    if current() {
                        self.view.try_update(|v| {
                            v.status = AiStatus::Streaming;
                            v.text = text.to_string();
                        });
                    }
                },
            )
            .await;
            if !current() {
                return;
            }
            match reply {
                Ok(text) => {
                    if let Some(key) = key.filter(|_| !text.trim().is_empty()) {
                        // ponytail: read-modify-write without a queue; two answers landing
                        // in the same tick can drop one cache entry, which is regenerated.
                        let mut cache: AiCache = store::get("aiCache").await.unwrap_or_default();
                        let entry = AiCacheEntry {
                            text: text.clone(),
                            target: "claude".into(),
                            model: model.into(),
                            at: crate::js::now(),
                        };
                        cache_put(&mut cache, key, entry);
                        let _ = store::set("aiCache", &cache).await;
                    }
                    self.view.try_update(|v| {
                        v.status = AiStatus::Done;
                        v.text = text;
                    });
                }
                Err(error) => {
                    let stopped = controller.is_some_and(|c| c.signal().aborted());
                    self.view.try_update(|v| {
                        // Stopped by the reader: keep what streamed so far.
                        v.status = match (stopped, v.text.is_empty()) {
                            (true, true) => AiStatus::Idle,
                            (true, false) => AiStatus::Done,
                            _ => AiStatus::Error,
                        };
                        v.error = error;
                    });
                }
            }
        });
    }
}

fn model_label(model: &str) -> String {
    if model.starts_with("claude-haiku") {
        "Claude Haiku".into()
    } else if model.starts_with("claude-sonnet") {
        "Claude Sonnet".into()
    } else {
        model.into()
    }
}

/// Every AI answer renders through this: what was written and which model wrote it.
#[component]
pub fn AiNote(ai: Ai) -> impl IntoView {
    let view = ai.view;
    let status = move || view.with(|v| v.status);
    let busy = move || matches!(status(), AiStatus::Working | AiStatus::Streaming);
    let quiet = move || {
        (status() == AiStatus::Unavailable).then(|| {
            view! {
                <div class="ai-note ai-note--quiet">
                    <p>
                        {move || format!("{}. ", view.with(|v| v.error.clone()))}
                        <button type="button" class="ai-note-link" on:click=|_| { let _ = chrome::open_options_page(); }>"Open Settings"</button>
                    </p>
                </div>
            }
        })
    };
    view! {
        <Show when=move || !matches!(status(), AiStatus::Idle | AiStatus::Unavailable) fallback=quiet>
            <div class="ai-note" aria-live="polite" aria-busy=move || busy().to_string()>
                <Show
                    when=move || status() == AiStatus::Working && view.with(|v| v.text.is_empty())
                    fallback=move || view! { <Markdown text=Signal::derive(move || view.with(|v| v.text.clone())) /> }
                >
                    <div class="ai-note-skeleton" aria-label="Writing"><span></span><span></span></div>
                </Show>
                <Show when=move || status() == AiStatus::Error>
                    <p class="ai-note-error">{move || view.with(|v| v.error.clone())}</p>
                </Show>
                <div class="ai-note-foot">
                    <Show when=move || view.with(|v| !v.model.is_empty())>
                        <small class="ai-note-chip" title=move || view.with(|v| v.reason.clone())>
                            {move || view.with(|v| model_label(&v.model))}
                        </small>
                    </Show>
                    <Show when=busy>
                        <button type="button" class="ai-note-link" on:click=move |_| ai.stop()>"Stop"</button>
                    </Show>
                </div>
            </div>
        </Show>
    }
}

/// Markdown and maths. KaTeX loads with the first formula; until then the
/// formula shows as its source.
#[component]
pub fn Markdown(#[prop(into)] text: Signal<String>) -> impl IntoView {
    let katex = RwSignal::new(false);
    Effect::new(move |_| {
        if !katex.get() && text.with(|t| !lift_math(t).1.is_empty()) {
            leptos::task::spawn_local(async move {
                if JsFuture::from(load_katex()).await.is_ok() {
                    katex.try_set(true);
                }
            });
        }
    });
    let html = move || {
        let ready = katex.get();
        text.with(|t| {
            render_markdown(t, |tex, display| {
                ready.then(|| render_tex(tex, display)).flatten()
            })
        })
    };
    view! { <div class="md" inner_html=html></div> }
}

/// Under a finished definition: keep it as a note on the term, or not.
/// Declining only hides the question; the definition stays up.
#[component]
pub fn SaveNotePrompt(ai: Ai, on_save: Callback<String>) -> impl IntoView {
    let declined = RwSignal::new(false);
    let ready = move || {
        !declined.get()
            && ai
                .view
                .with(|v| v.status == AiStatus::Done && !v.text.is_empty())
    };
    view! {
        <Show when=ready>
            <div class="ai-note-actions" role="group" aria-label="Save as a note">
                <span>"Save as a note here?"</span>
                // Notes are plain text, so the definition's bold markers would show as asterisks.
                <button type="button" class="ai-note-btn ai-note-btn--primary" on:click=move |_| {
                    on_save.run(ai.view.with_untracked(|v| v.text.replace("**", "")));
                }>"Save note"</button>
                <button type="button" class="ai-note-btn" on:click=move |_| declined.set(true)>"No"</button>
            </div>
        </Show>
    }
}

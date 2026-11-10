//! The reader asks: a question at a section's end or after a stall, and the
//! explain-back (problem, trick, why) graded to the gap and where to look.

use crate::pages::ai::{use_ai, AiNote, AiStatus};
use crate::store;
use leptos::html;
use leptos::prelude::*;
use reader_core::ai::AiRequest;
use reader_core::explain::{
    grade_request, parse_grades, record, ExplainBack, ExplainBacks, Grade, Part, Status,
};

/// One question in the margin. Writing an answer keeps it as a note; Esc or
/// "Not now" puts it away.
#[component]
pub fn QuestionCard(
    about: String,
    request: AiRequest,
    on_close: Callback<()>,
    /// The question and the reader's answer, as one note
    on_keep: Callback<String>,
) -> impl IntoView {
    let ai = use_ai();
    ai.start(request);
    let answer = RwSignal::new(String::new());
    let keep = move || {
        let a = answer.get_untracked().trim().to_string();
        if !a.is_empty() {
            let q = ai.view.with_untracked(|v| v.text.trim().to_string());
            on_keep.run(format!("Q: {q} / A: {a}"));
            on_close.run(());
        }
    };
    view! {
        <aside class="reader-question" aria-label="A question for you" on:keydown=move |e: web_sys::KeyboardEvent| {
            if e.key() == "Escape" { on_close.run(()); }
        }>
            <p class="define-label">{format!("A question about {about}")}</p>
            <AiNote ai=ai />
            <Show when=move || ai.view.with(|v| v.status == AiStatus::Done)>
                <label class="define-label" for="question-answer">"Your answer, in your own words"</label>
                <textarea id="question-answer" class="answer-input" rows="3" prop:value=move || answer.get() on:input=move |e| answer.set(event_target_value(&e)) on:keydown=move |e: web_sys::KeyboardEvent| {
                    if e.key() == "Enter" && (e.meta_key() || e.ctrl_key()) { keep(); }
                }></textarea>
            </Show>
            <div class="reader-question-actions">
                <Show when=move || ai.view.with(|v| v.status == AiStatus::Done)>
                    <button type="button" class="fc-primary-btn" disabled=move || answer.with(|a| a.trim().is_empty()) on:click=move |_| keep()>"Keep as a note"</button>
                </Show>
                <button type="button" class="ghost-btn" on:click=move |_| on_close.run(())>"Not now"</button>
                <kbd>"Esc"</kbd>
            </div>
        </aside>
    }
}

/// Problem, trick, why, in the reader's words; graded against the paper's
/// pages to what is missing and the page to look at. The grade never carries
/// the answer: `parse_grades` keeps only status, gap and page.
const DRAFT_DELAY_MS: u64 = 600;

#[component]
pub fn ExplainPanel(
    doc_key: String,
    page_texts: Signal<Option<Vec<String>>>,
    page_count: Signal<u32>,
    on_jump: Callback<u32>,
    on_close: Callback<()>,
) -> impl IntoView {
    let ai = use_ai();
    let fields = Part::ALL.map(|_| RwSignal::new(String::new()));
    let grades = RwSignal::new(None::<Vec<Grade>>);
    let unreadable = RwSignal::new(false);
    let saved = StoredValue::new(None::<[String; 3]>);
    let draft_key = StoredValue::new(format!("explainDraft:{doc_key}"));
    let loaded = RwSignal::new(false);
    let draft_status = RwSignal::new("Loading draft…");
    leptos::task::spawn_local(async move {
        match store::get::<[String; 3]>(&draft_key.get_value()).await {
            Ok(draft) => {
                for (field, text) in fields.into_iter().zip(draft) {
                    field.try_set(text);
                }
                loaded.try_set(true);
                draft_status.try_set("Draft saved on this device");
            }
            // Never leave the panel locked: an unreadable draft is replaced by a new one.
            Err(_) => {
                loaded.try_set(true);
                draft_status.try_set("Couldn't load your draft. Typing here starts a new one.");
            }
        }
    });
    // One write per pause in typing, not per keystroke.
    // ponytail: closing the panel inside the delay drops the last keystrokes.
    let pending = StoredValue::new(None::<TimeoutHandle>);
    let write_draft = move || {
        let draft = fields.map(|f| f.get_untracked());
        let key = draft_key.get_value();
        leptos::task::spawn_local(async move {
            let status = if store::set(&key, &draft).await.is_ok() {
                "Draft saved on this device"
            } else {
                "Couldn't save your draft. Keep this panel open and try editing again."
            };
            draft_status.try_set(status);
        });
    };
    let save_draft = move || {
        draft_status.set("Saving draft…");
        if let Some(h) = pending.try_update_value(Option::take).flatten() {
            h.clear();
        }
        pending.set_value(
            set_timeout_with_handle(
                write_draft,
                std::time::Duration::from_millis(DRAFT_DELAY_MS),
            )
            .ok(),
        );
    };
    let first: NodeRef<html::Textarea> = NodeRef::new();
    Effect::new(move |_| {
        // Next frame: by then the textarea's disabled attribute is gone.
        if let Some(t) = first.get().filter(|_| loaded.get()) {
            request_animation_frame(move || {
                let _ = t.focus();
            });
        }
    });

    // A finished grade: parse, show, keep.
    let doc_key = StoredValue::new(doc_key);
    Effect::new(move |_| {
        let (status, text) = ai.view.with(|v| (v.status, v.text.clone()));
        if status != AiStatus::Done {
            return;
        }
        let Some(said) = saved.get_value() else {
            return;
        };
        match parse_grades(&text, page_count.get_untracked()) {
            None => unreadable.set(true),
            Some(g) => {
                grades.set(Some(g.clone()));
                let key = doc_key.get_value();
                // Graded: the draft is done; reopening starts fresh.
                if let Some(h) = pending.try_update_value(Option::take).flatten() {
                    h.clear();
                }
                let draft = draft_key.get_value();
                draft_status.set("Graded. The draft is cleared from this device.");
                leptos::task::spawn_local(async move {
                    let kept = store::with_lock("explainBacks", async move {
                        let mut all: ExplainBacks =
                            store::get("explainBacks").await.unwrap_or_default();
                        let [problem, trick, why] = said;
                        record(
                            &mut all,
                            &key,
                            ExplainBack {
                                at: crate::js::now(),
                                problem,
                                trick,
                                why,
                                grades: g,
                            },
                        );
                        store::set("explainBacks", &all).await.is_ok()
                    })
                    .await;
                    // The draft goes only once the graded copy is kept.
                    if kept {
                        let _ = store::remove(&[draft]).await;
                    }
                });
            }
        }
        saved.set_value(None);
    });

    let submit = move |e: web_sys::SubmitEvent| {
        e.prevent_default();
        let said = fields.map(|f| f.get_untracked());
        let Some(pages) = page_texts.get_untracked() else {
            return;
        };
        grades.set(None);
        unreadable.set(false);
        saved.set_value(Some(said.clone()));
        ai.start(grade_request(&said[0], &said[1], &said[2], &pages));
    };
    let busy = move || {
        ai.view
            .with(|v| matches!(v.status, AiStatus::Working | AiStatus::Streaming))
    };
    let empty = move || fields.iter().all(|f| f.with(|t| t.trim().is_empty()));

    view! {
        <section class="reader-notes reader-explain" aria-labelledby="explain-heading" on:keydown=move |e: web_sys::KeyboardEvent| {
            if e.key() == "Escape" { on_close.run(()); }
        }>
            <h2 id="explain-heading">"Explain it back"</h2>
            <p class="reader-explain-lede">"As if to a friend, in your own words. You get back what is missing and where to look, not the answer."</p>
            <p class="define-label" role="status">{move || draft_status.get()}</p>
            <form on:submit=submit>
                {Part::ALL.iter().zip(fields).enumerate().map(|(i, (part, field))| {
                    let id = format!("explain-{part:?}").to_lowercase();
                    let node = if i == 0 { first } else { NodeRef::new() };
                    view! {
                        <label class="define-label" for=id.clone()>{part.label()}</label>
                        <textarea node_ref=node id=id class="answer-input" rows="3" disabled=move || !loaded.get() prop:value=move || field.get() on:input=move |e| { field.set(event_target_value(&e)); save_draft(); }></textarea>
                    }
                }).collect_view()}
                <button type="submit" class="fc-primary-btn" disabled=move || !loaded.get() || busy() || empty() || page_texts.with(Option::is_none)>
                    {move || if busy() { "Checking…" } else { "Check my explanation" }}
                </button>
            </form>
            // Only the quiet states show through; the raw JSON never renders.
            <Show when=move || ai.view.with(|v| matches!(v.status, AiStatus::Unavailable | AiStatus::Error))>
                <AiNote ai=ai />
            </Show>
            <Show when=move || unreadable.get()>
                <p class="ai-note-error" role="alert">"The check came back unreadable. Try again."</p>
            </Show>
            {move || grades.get().map(|list| view! {
                <ul class="reader-explain-grades" aria-live="polite">
                    {list.into_iter().map(|g| {
                        let status = match g.status { Status::Got => "Got it", Status::Partial => "Partly", Status::Missing => "Missing" };
                        view! {
                            <li data-status=format!("{:?}", g.status).to_lowercase()>
                                <strong>{format!("{}: {status}", g.part.label())}</strong>
                                {(!g.gap.is_empty()).then(|| view! { <p>{g.gap.clone()}</p> })}
                                {g.page.map(|p| view! { <button type="button" class="ghost-btn" on:click=move |_| on_jump.run(p)>{format!("Look at page {p}")}</button> })}
                            </li>
                        }
                    }).collect_view()}
                </ul>
            })}
        </section>
    }
}

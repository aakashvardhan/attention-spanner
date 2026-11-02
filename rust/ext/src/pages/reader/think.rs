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
                <textarea id="question-answer" class="provoke-answer" rows="3" prop:value=move || answer.get() on:input=move |e| answer.set(event_target_value(&e)) on:keydown=move |e: web_sys::KeyboardEvent| {
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
    let first: NodeRef<html::Textarea> = NodeRef::new();
    Effect::new(move |_| {
        if let Some(t) = first.get() {
            let _ = t.focus();
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
                leptos::task::spawn_local(async move {
                    // ponytail: read-modify-write; two tabs grading the same second can drop one entry.
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
                    let _ = store::set("explainBacks", &all).await;
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
            <form on:submit=submit>
                {Part::ALL.iter().zip(fields).enumerate().map(|(i, (part, field))| {
                    let id = format!("explain-{part:?}").to_lowercase();
                    let node = if i == 0 { first } else { NodeRef::new() };
                    view! {
                        <label class="define-label" for=id.clone()>{part.label()}</label>
                        <textarea node_ref=node id=id class="provoke-answer" rows="3" prop:value=move || field.get() on:input=move |e| field.set(event_target_value(&e))></textarea>
                    }
                }).collect_view()}
                <button type="submit" class="fc-primary-btn" disabled=move || busy() || empty() || page_texts.with(Option::is_none)>
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

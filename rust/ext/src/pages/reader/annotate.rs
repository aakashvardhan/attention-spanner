//! Highlights, sticky notes and the notes list. Every change goes to the worker
//! as a message; the list re-renders from storage.

use crate::pages::send;
use leptos::html;
use leptos::prelude::*;
use reader_core::annotations::{annotation_offset, annotation_swatch, annotation_tint};
use reader_core::messages::{AnnotationPatch, Message};
use reader_core::types::{Annotation, AnnotationAnchor, AnnotationColor, AnnotationKind};
use std::sync::{Arc, Mutex};

pub const COLORS: [AnnotationColor; 4] = [
    AnnotationColor::Yellow,
    AnnotationColor::Green,
    AnnotationColor::Blue,
    AnnotationColor::Pink,
];

pub fn color_name(c: AnnotationColor) -> String {
    format!("{c:?}").to_lowercase()
}

/// Fire and forget: storage changes bring the result back.
pub fn post(msg: Message) {
    let Ok(value) = serde_json::to_value(msg) else {
        return;
    };
    leptos::task::spawn_local(async move {
        send(value).await;
    });
}

fn page_of(a: &Annotation) -> Option<u32> {
    match a.anchor {
        AnnotationAnchor::Pdf { page, .. } => Some(page),
        AnnotationAnchor::Text { .. } => None,
    }
}

/// Highlights, pins and the note-mode click target for one page; the active
/// annotation's popover sits in the same percent-positioned layer, so it
/// tracks zoom with everything else.
#[component]
pub fn AnnotationLayer(
    page: u32,
    annotations: Signal<Vec<Annotation>>,
    active: RwSignal<Option<String>>,
    note_mode: Signal<bool>,
    /// (page, x, y) as 0-1 fractions of the page
    on_place: Callback<(u32, f64, f64)>,
) -> impl IntoView {
    let mine = Memo::new(move |_| {
        annotations.with(|all| {
            all.iter()
                .filter(|a| page_of(a) == Some(page))
                .cloned()
                .collect::<Vec<_>>()
        })
    });
    // Only the id, so the popover stays mounted while its annotation's note or colour changes.
    let active_here = Memo::new(move |_| {
        active
            .get()
            .filter(|id| mine.with(|m| m.iter().any(|a| &a.id == id)))
    });
    let layer: NodeRef<html::Div> = NodeRef::new();
    let place = move |e: web_sys::MouseEvent| {
        if !note_mode.get_untracked() {
            return;
        }
        let Some(el) = layer.get_untracked() else {
            return;
        };
        let r = el.get_bounding_client_rect();
        on_place.run((
            page,
            (f64::from(e.client_x()) - r.left()) / r.width(),
            (f64::from(e.client_y()) - r.top()) / r.height(),
        ));
    };
    view! {
        <div node_ref=layer class=move || if note_mode.get() { "annot-layer note-mode" } else { "annot-layer" } on:click=place>
            <For each=move || mine.get() key=|a| (a.id.clone(), a.updated_at) let:a>
                {
                    let id = a.id.clone();
                    let activate = move |e: web_sys::MouseEvent| {
                        e.stop_propagation();
                        active.set(Some(id.clone()));
                    };
                    match (&a.kind, &a.anchor) {
                        (AnnotationKind::Highlight, AnnotationAnchor::Pdf { rects, .. }) => {
                            let last = rects.len().saturating_sub(1);
                            let has_note = !a.note.is_empty();
                            rects.iter().enumerate().map(|(i, r)| {
                                let activate = activate.clone();
                                // The note dot sits on the last rect only: one per highlight, not per line.
                                let class = if has_note && i == last { "annot-highlight annot-has-note" } else { "annot-highlight" };
                                let style = format!(
                                    "left: {}%; top: {}%; width: {}%; height: {}%; background: {}",
                                    r.x * 100.0, r.y * 100.0, r.w * 100.0, r.h * 100.0, annotation_tint(a.color)
                                );
                                view! { <div class=class style=style on:click=activate></div> }
                            }).collect_view().into_any()
                        }
                        (_, AnnotationAnchor::Pdf { x, y, .. }) => {
                            let style = format!("left: {}%; top: {}%; background: {}", x * 100.0, y * 100.0, annotation_swatch(a.color));
                            view! { <div class="annot-pin" style=style on:click=activate></div> }.into_any()
                        }
                        _ => ().into_any(),
                    }
                }
            </For>
            {move || active_here.get().map(|id| {
                let lookup = id.clone();
                let annotation = Signal::derive(move || mine.with(|m| m.iter().find(|a| a.id == lookup).cloned()));
                view! { <NotePopover id=id annotation=annotation active=active /> }
            })}
        </div>
    }
}

#[component]
fn NotePopover(
    id: String,
    annotation: Signal<Option<Annotation>>,
    active: RwSignal<Option<String>>,
) -> impl IntoView {
    let Some(start) = annotation.get_untracked() else {
        return ().into_any();
    };
    let note = RwSignal::new(start.note.clone());
    // Plain shared cells, not signals: the commit below runs during unmount, after the
    // reactive values may already be gone.
    let typed = Arc::new(Mutex::new(start.note.clone()));
    let committed = Arc::new(Mutex::new(start.note.clone()));
    let commit = {
        let (typed, committed, id) = (typed.clone(), committed.clone(), id.clone());
        move || {
            let now = typed.lock().unwrap().clone();
            if now != *committed.lock().unwrap() {
                *committed.lock().unwrap() = now.clone();
                post(Message::AnnotUpdate {
                    id: id.clone(),
                    patch: AnnotationPatch {
                        note: Some(now),
                        ..AnnotationPatch::default()
                    },
                });
            }
        }
    };
    // A note changed elsewhere (another tab) shows here.
    {
        let (typed, committed) = (typed.clone(), committed.clone());
        Effect::new(move |_| {
            if let Some(a) = annotation.get() {
                if a.note != *committed.lock().unwrap() {
                    *committed.lock().unwrap() = a.note.clone();
                    *typed.lock().unwrap() = a.note.clone();
                    note.set(a.note);
                }
            }
        });
    }
    // The click outside that closes this popover unmounts it before the
    // textarea's blur fires, so the edit is flushed on unmount; blur covers
    // focus moves that keep it open (tabbing to a swatch).
    on_cleanup({
        let commit = commit.clone();
        move || commit()
    });

    let textarea: NodeRef<html::Textarea> = NodeRef::new();
    Effect::new(move |_| {
        if let Some(t) = textarea.get() {
            let _ = t.focus();
        }
    });

    // Just below the annotation: the first rect of a highlight, the pin of a sticky.
    let (left, top) = match &start.anchor {
        AnnotationAnchor::Pdf { rects, .. }
            if start.kind == AnnotationKind::Highlight && !rects.is_empty() =>
        {
            (rects[0].x, rects[0].y + rects[0].h)
        }
        AnnotationAnchor::Pdf { x, y, .. } => (*x, *y),
        AnnotationAnchor::Text { .. } => (0.0, 0.0),
    };
    let snippet = (start.kind == AnnotationKind::Highlight && !start.text.is_empty())
        .then(|| view! { <div class="annot-popover-snippet">{start.text.clone()}</div> });
    let color = Signal::derive(move || annotation.with(|a| a.as_ref().map(|a| a.color)));
    let close = move || active.set(None);

    let on_input = {
        let typed = typed.clone();
        move |e: web_sys::Event| {
            let v = event_target_value(&e);
            *typed.lock().unwrap() = v.clone();
            note.set(v);
        }
    };
    let on_blur = {
        let commit = commit.clone();
        move |_| commit()
    };
    let on_key = {
        let commit = commit.clone();
        move |e: web_sys::KeyboardEvent| {
            if e.key() == "Enter" && (e.meta_key() || e.ctrl_key()) {
                commit();
                close();
            } else if e.key() == "Escape" {
                close();
            }
        }
    };
    let on_close = move |_| {
        commit();
        close();
    };
    let swatches = COLORS
        .iter()
        .map(|&c| {
            let id = id.clone();
            view! {
                <button
                    class=move || if color.get() == Some(c) { "annot-swatch active" } else { "annot-swatch" }
                    style=format!("background: {}", annotation_swatch(c))
                    title=color_name(c)
                    aria-label=format!("Colour {}", color_name(c))
                    on:click=move |_| post(Message::AnnotUpdate { id: id.clone(), patch: AnnotationPatch { color: Some(c), ..AnnotationPatch::default() } })
                ></button>
            }
        })
        .collect_view();
    let delete_id = id.clone();
    view! {
        <div class="annot-popover" style=format!("left: {}%; top: {}%", left * 100.0, top * 100.0) on:click=|e| e.stop_propagation()>
            {snippet}
            <textarea node_ref=textarea prop:value=move || note.get() placeholder="Add a note…" aria-label="Note" on:input=on_input on:blur=on_blur on:keydown=on_key></textarea>
            <div class="annot-popover-actions">
                {swatches}
                <button class="ghost-btn annot-delete" on:click=move |_| {
                    post(Message::AnnotDelete { id: delete_id.clone() });
                    close();
                }>"Delete"</button>
                <button class="ghost-btn" aria-label="Close" on:click=on_close>"×"</button>
            </div>
        </div>
    }
    .into_any()
}

/// The floating pill over a text selection: pick a highlight colour.
#[component]
pub fn SelectionMenu(x: f64, y: f64, on_pick: Callback<AnnotationColor>) -> impl IntoView {
    view! {
        <div
            class="annot-selection-menu"
            style=format!("left: {x}px; top: {y}px")
            role="toolbar"
            aria-label="Highlight colour"
            // The selection collapses on a pointerdown outside it; keep it alive here.
            on:pointerdown=|e| e.prevent_default()
        >
            {COLORS.iter().map(|&c| view! {
                <button
                    type="button"
                    class="annot-swatch"
                    style=format!("background: {}", annotation_swatch(c))
                    title=format!("Highlight in {}", color_name(c))
                    aria-label=format!("Highlight in {}", color_name(c))
                    on:click=move |_| on_pick.run(c)
                ></button>
            }).collect_view()}
        </div>
    }
}

/// Every note in the document, by page, in reading order (already sorted).
#[component]
pub fn NotesSidebar(
    annotations: Signal<Vec<Annotation>>,
    on_jump: Callback<(u32, f64)>,
) -> impl IntoView {
    let groups = move || {
        let mut groups: Vec<(u32, Vec<Annotation>)> = vec![];
        for a in annotations.get() {
            let Some(page) = page_of(&a) else { continue };
            match groups.last_mut() {
                Some((p, list)) if *p == page => list.push(a),
                _ => groups.push((page, vec![a])),
            }
        }
        groups
    };
    view! {
        <nav class="reader-notes">
            <h2>"Notes"</h2>
            <Show when=move || annotations.with(Vec::is_empty)>
                <p class="reader-notes-empty">"Select text in the PDF to highlight it."</p>
            </Show>
            {move || groups().into_iter().map(|(page, list)| view! {
                <div>
                    <h3>{format!("Page {page}")}</h3>
                    {list.into_iter().map(|a| {
                        let offset = annotation_offset(&a);
                        let id = a.id.clone();
                        let (text, note) = if a.kind == AnnotationKind::Highlight {
                            (if a.text.is_empty() { "(highlight)".to_string() } else { a.text.clone() }, (!a.note.is_empty()).then(|| a.note.clone()))
                        } else {
                            (if a.note.is_empty() { "Sticky note".to_string() } else { a.note.clone() }, None)
                        };
                        // Two sibling buttons, not one inside the other, so delete is reachable by Tab.
                        let label = format!("Delete: {text}");
                        view! {
                            <div class="annot-row">
                                <button type="button" class="annot-row-jump" on:click=move |_| on_jump.run((page, offset))>
                                    <span class="annot-row-swatch" style=format!("background: {}", annotation_swatch(a.color))></span>
                                    <span class="annot-row-body">
                                        <span class="annot-row-text">{text}</span>
                                        {note.map(|n| view! { <span class="annot-row-note">{n}</span> })}
                                    </span>
                                </button>
                                <button type="button" class="annot-row-delete" title="Delete" aria-label=label on:click=move |_| {
                                    post(Message::AnnotDelete { id: id.clone() });
                                }>"×"</button>
                            </div>
                        }
                    }).collect_view()}
                </div>
            }).collect_view()}
        </nav>
    }
}

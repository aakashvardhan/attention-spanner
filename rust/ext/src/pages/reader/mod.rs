//! The reader (src/pages/reader/Reader.tsx, PdfReader.tsx).

mod annotate;
mod define;
mod think;
mod ui;
mod viewport;

use super::{patch_settings, send, use_settings, use_storage};
use crate::pdfjs::{self, PageSize};
use annotate::{post, AnnotationLayer, NotesSidebar, SelectionMenu};
use define::{define_target, pending_selection, DefinePopover, DefineTarget, PendingSelection};
use leptos::prelude::*;
use reader_core::annotations::{sort_annotations, DEFAULT_ANNOTATION_COLOR};
use reader_core::figures::captions_from_lines;
use reader_core::messages::{AnnotationDraft, Message};
use reader_core::outline::{heading_for_page, section_index_at, top_level, FlatOutlineItem};
use reader_core::papers::paper_match_key;
use reader_core::pdf::{reader_pdf_src, PdfPosition};
use reader_core::questions::{question_request, section_finished, spot_at, spot_pages, Spot};
use reader_core::reading_aids::{minutes_left, time_left_label, word_counts};
use reader_core::types::{
    Annotation, AnnotationAnchor, AnnotationColor, AnnotationKind, AnnotationRect, Paper,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use think::{ExplainPanel, QuestionCard};
use ui::{FindPanel, OutlineRail, OutlineSidebar, ReaderCapsule, ReaderToolbar};
use viewport::{Jump, PdfViewport};
use wasm_bindgen::JsValue;

/// One progress write at most every 5s; positions in between are dropped.
const PROGRESS_THROTTLE_MS: i64 = 5_000;
/// The toolbar sleeps after this long of reading, and wakes at the top edge or on scroll-up.
const IDLE_MS: u64 = 2500;
const WAKE_ZONE_PX: i32 = 48;
/// This long on one view with no scroll is a stall, and gets a question.
/// ponytail: a constant; a Settings knob when someone wants a different pace.
const QUESTION_STALL_MS: i64 = 120_000;

#[oxichrome::page(path = "src/pages/reader/index.html", title = "Reader", css = ["assets/theme.css", "assets/reader.css", "assets/aiNote.css", "assets/markdown.css", "assets/katex.min.css"])]
pub fn Reader() -> impl IntoView {
    // Web-accessible so the PDF redirect can land here; no business inside another site's frame.
    let framed = window()
        .top()
        .ok()
        .flatten()
        .is_some_and(|top| !JsValue::from(top).eq(&JsValue::from(window())));
    let src = reader_pdf_src(&window().location().search().unwrap_or_default());
    view! {
        <div id="root">
            {if framed {
                ().into_any()
            } else if src.is_empty() {
                view! { <main class="reader-fallback"><p>"Nothing to show. Open a paper from your shelf on the new tab."</p></main> }.into_any()
            } else {
                view! { <PdfReader src=src /> }.into_any()
            }}
        </div>
    }
}

/// The shelved paper this PDF belongs to (abs/pdf/version variants collapse).
fn find_paper(papers: &[Paper], src: &str) -> Option<Paper> {
    let key = paper_match_key(src)?;
    papers
        .iter()
        .find(|p| {
            paper_match_key(&p.url).as_deref() == Some(key.as_str())
                || p.pdf
                    .as_ref()
                    .is_some_and(|d| paper_match_key(&d.url).as_deref() == Some(key.as_str()))
        })
        .cloned()
}

#[derive(Clone)]
enum Load {
    Loading,
    Error(String),
    Ready,
}

#[component]
fn PdfReader(src: String) -> impl IntoView {
    let load = RwSignal::new(Load::Loading);
    let doc: StoredValue<JsValue, LocalStorage> = StoredValue::new_local(JsValue::NULL);
    let sizes = RwSignal::new(Vec::<PageSize>::new());
    let outline = RwSignal::new(Vec::<FlatOutlineItem>::new());
    let pdf_title = RwSignal::new(String::new());
    let page_texts = RwSignal::new(None::<Vec<String>>);
    let figures = RwSignal::new(HashMap::<String, PdfPosition>::new());

    let (papers, papers_loaded) = use_storage::<Vec<Paper>>("papers");
    let (annotations, _) = use_storage::<Vec<Annotation>>("annotations");
    let (settings, _) = use_settings();
    let src_key = src.clone();
    let paper = Memo::new(move |_| find_paper(&papers.get(), &src_key));
    let doc_key = reader_core::annotations::annotation_doc_key(&src);
    // Only page-anchored ones: an article annotation colliding on the key has no page box.
    let doc_annotations = {
        let doc_key = doc_key.clone();
        Memo::new(move |_| {
            annotations.with(|all| {
                let mine: Vec<Annotation> = all
                    .iter()
                    .filter(|a| {
                        a.doc_key == doc_key && matches!(a.anchor, AnnotationAnchor::Pdf { .. })
                    })
                    .cloned()
                    .collect();
                sort_annotations(&mine)
            })
        })
    };
    let annotation_count = Signal::derive(move || doc_annotations.with(Vec::len));

    {
        let src = src.clone();
        leptos::task::spawn_local(async move {
            match pdfjs::open(&src).await {
                Err(message) => load.set(Load::Error(message)),
                Ok(opened) => {
                    doc.set_value(opened.doc.clone());
                    sizes.set(opened.sizes);
                    outline.set(opened.outline);
                    pdf_title.set(opened.title);
                    load.set(Load::Ready);
                    let d = opened.doc;
                    if opened.progressive {
                        // ponytail: one layout shift when sizes differ; chunked updates if it bothers.
                        if let Ok(real) = pdfjs::all_sizes(&d).await {
                            if sizes.with_untracked(|s| s != &real) {
                                sizes.set(real);
                            }
                        }
                    }
                    page_texts.set(Some(pdfjs::page_texts(&d).await.unwrap_or_default()));
                    if let Ok(lines) = pdfjs::page_lines(&d).await {
                        figures.set(captions_from_lines(&lines));
                    }
                }
            }
        });
    }

    // #page=N (a deep link) wins over the saved position.
    let hash_page: Option<u32> = window()
        .location()
        .hash()
        .ok()
        .and_then(|h| h.split("page=").nth(1).and_then(|n| n.parse().ok()))
        .filter(|n| *n > 0);
    let position = RwSignal::new(PdfPosition {
        page: 1,
        offset: 0.0,
    });
    let zoom = RwSignal::new(1.0);
    let outline_open = RwSignal::new(false);
    let note_mode = RwSignal::new(false);
    let panel = RwSignal::new("none");
    let (jump, set_jump) = signal(None::<Jump>);
    let jump_seq = StoredValue::new(0u64);
    let go = Callback::new(move |page: u32| {
        jump_seq.update_value(|s| *s += 1);
        set_jump.set(Some((page, 0.0, jump_seq.get_value())));
    });

    let page_count = Signal::derive(move || sizes.with(Vec::len) as u32);

    // Annotations: the active one's popover, a selection waiting for a colour, a clicked term.
    let active = RwSignal::new(None::<String>);
    let pending = RwSignal::new(None::<PendingSelection>);
    let define = RwSignal::new(None::<DefineTarget>);
    let draft_base = {
        let (doc_key, src) = (doc_key.clone(), src.clone());
        StoredValue::new(
            move |kind: AnnotationKind, page: u32, rects: Vec<AnnotationRect>, x: f64, y: f64| {
                AnnotationDraft {
                    tag: None,
                    doc_key: doc_key.clone(),
                    doc_url: src.clone(),
                    paper_id: paper.get_untracked().map(|p| p.id),
                    kind,
                    anchor: AnnotationAnchor::Pdf { page, rects, x, y },
                    text: String::new(),
                    color: DEFAULT_ANNOTATION_COLOR,
                    note: String::new(),
                }
            },
        )
    };
    let create_highlight = move |page: u32,
                                 rects: Vec<AnnotationRect>,
                                 text: String,
                                 color: AnnotationColor,
                                 note: String| {
        let draft = AnnotationDraft {
            text,
            color,
            note,
            ..draft_base.with_value(|d| d(AnnotationKind::Highlight, page, rects, 0.0, 0.0))
        };
        post(Message::AnnotAdd { draft });
    };
    let place_sticky = Callback::new(move |(page, x, y): (u32, f64, f64)| {
        note_mode.set(false);
        let draft = draft_base.with_value(|d| d(AnnotationKind::Sticky, page, vec![], x, y));
        let Ok(msg) = serde_json::to_value(Message::AnnotAdd { draft }) else {
            return;
        };
        leptos::task::spawn_local(async move {
            let reply = send(msg).await;
            if let Some(id) = reply["annotation"]["id"].as_str() {
                active.set(Some(id.to_string()));
            }
        });
    });
    let pick_color = Callback::new(move |color: AnnotationColor| {
        if let Some(sel) = pending.get_untracked() {
            for (page, rects) in sel.by_page {
                create_highlight(page, rects, sel.text.clone(), color, String::new());
            }
        }
        if let Ok(Some(s)) = window().get_selection() {
            let _ = s.remove_all_ranges();
        }
        pending.set(None);
    });
    let page_extra = Callback::new(move |page: u32| {
        view! { <AnnotationLayer page=page annotations=doc_annotations.into() active=active note_mode=note_mode.into() on_place=place_sticky /> }.into_any()
    });
    // A word on the text layer asks for its meaning; note mode places pins instead.
    let on_text_click = Callback::new(move |e: web_sys::MouseEvent| {
        if !note_mode.get_untracked() {
            if let Some(t) = define_target(&e) {
                define.set(Some(t));
            }
        }
    });
    let up = window_event_listener(leptos::ev::pointerup, move |_| {
        if let Some(p) = pending_selection() {
            pending.set(Some(p));
        }
    });
    // Anything that is not an annotation, its popover, or the colour pill closes the popover.
    let down = window_event_listener(leptos::ev::pointerdown, move |e| {
        use wasm_bindgen::JsCast;
        let keep = e
            .target()
            .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
            .and_then(|t| {
                t.closest(".annot-popover, .annot-highlight, .annot-pin, .annot-selection-menu")
                    .ok()
                    .flatten()
            })
            .is_some();
        if !keep {
            active.set(None);
        }
    });
    // selectionchange fires on the document only (it does not reach window).
    let collapsed = wasm_bindgen::closure::Closure::<dyn Fn()>::new(move || {
        if window()
            .get_selection()
            .ok()
            .flatten()
            .is_none_or(|s| s.is_collapsed())
        {
            pending.set(None);
        }
    });
    {
        use wasm_bindgen::JsCast;
        let _ = document().add_event_listener_with_callback(
            "selectionchange",
            collapsed.as_ref().unchecked_ref(),
        );
    }
    let collapsed = StoredValue::new_local(collapsed);
    on_cleanup(move || {
        up.remove();
        down.remove();
        use wasm_bindgen::JsCast;
        collapsed.with_value(|c| {
            let _ = document()
                .remove_event_listener_with_callback("selectionchange", c.as_ref().unchecked_ref());
        });
    });
    let left_off_for = move |page: u32| {
        heading_for_page(&outline.get_untracked(), page)
            .map(str::to_string)
            .unwrap_or_else(|| format!("Page {page} of {}", page_count.get_untracked()))
    };

    // Progress: throttled; off until the viewport has applied the saved position.
    let restored = StoredValue::new(false);
    let last_sent = StoredValue::new(0i64);
    // Held in a StoredValue so the closure below is Copy and can be shared.
    let src_progress = StoredValue::new(src.clone());
    let send_progress = move |force: bool| {
        let Some(p) = paper.get_untracked() else {
            return;
        };
        if !restored.get_value() || page_count.get_untracked() == 0 {
            return;
        }
        let now = crate::js::now();
        if !force && now - last_sent.get_value() < PROGRESS_THROTTLE_MS {
            return;
        }
        let since = last_sent.get_value();
        last_sent.set_value(now);
        let pos = position.get_untracked();
        // Credit at most one throttle window, so a reader left open can't bank hours.
        let delta = if since == 0 {
            0.0
        } else {
            ((now - since) as f64 / 1000.0).min((PROGRESS_THROTTLE_MS / 1000) as f64)
        };
        let msg = json!({
            "type": "PAPER_READER_PROGRESS", "paperId": p.id, "pdfUrl": src_progress.get_value(), "page": pos.page,
            "pageCount": page_count.get_untracked(), "offset": pos.offset, "leftOff": left_off_for(pos.page), "activeSecondsDelta": delta,
        });
        leptos::task::spawn_local(async move {
            send(msg).await;
        });
    };
    // Leaving the tab (or closing it) flushes the latest position.
    let flush_a = window_event_listener(leptos::ev::visibilitychange, move |_| send_progress(true));
    let flush_b = window_event_listener(leptos::ev::pagehide, move |_| send_progress(true));
    on_cleanup(move || {
        flush_a.remove();
        flush_b.remove();
    });

    let src_title = src.clone();
    let title = Signal::derive(move || {
        let from_paper = paper.get().map(|p| p.title).filter(|t| !t.is_empty());
        let from_pdf = Some(pdf_title.get()).filter(|t| !t.is_empty());
        from_paper.or(from_pdf).unwrap_or_else(|| {
            let last = src_title.rsplit('/').next().unwrap_or("PDF");
            js_sys::decode_uri_component(last)
                .ok()
                .and_then(|s| s.as_string())
                .unwrap_or_else(|| last.to_string())
        })
    });
    // Opening the reader starts (or joins) the reading session.
    Effect::new(move |_| {
        if matches!(load.get(), Load::Ready) {
            let t = title.get();
            leptos::task::spawn_local(async move {
                send(json!({ "type": "READER_OPENED", "title": t })).await;
            });
        }
    });

    let scan_dismissed = RwSignal::new(false);
    let looks_scanned = move || {
        page_texts.with(|t| {
            t.as_ref()
                .is_some_and(|t| t.concat().chars().filter(|c| !c.is_whitespace()).count() < 200)
        })
    };
    let counts = Memo::new(move |_| {
        page_texts.with(|t| {
            t.as_ref()
                .map(|t| word_counts(&t.iter().map(String::as_str).collect::<Vec<_>>()))
        })
    });
    let capsule_label = Signal::derive(move || {
        let pos = position.get();
        let left = time_left_label(minutes_left(
            counts.get().as_deref(),
            pos.page as usize - 1,
            pos.offset,
        ));
        [format!("p. {} of {}", pos.page, page_count.get()), left]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    });
    let progress = Signal::derive(move || {
        let (pos, n) = (position.get(), page_count.get());
        if n > 0 {
            (f64::from(pos.page) - 1.0 + pos.offset) / f64::from(n)
        } else {
            0.0
        }
    });
    // Top-level sections only: the rail is for orientation, not depth.
    let sections = Signal::derive(move || top_level(&outline.get()));
    let section_index =
        Signal::derive(move || section_index_at(&sections.get(), position.get().page));
    let section_toast = ui::use_section_toast(sections, section_index);

    // Questions: one at a section's end, or after a stall; never twice for one spot.
    let question = RwSignal::new(None::<(String, reader_core::ai::AiRequest)>);
    let asked = StoredValue::new(HashSet::<Spot>::new());
    let ask_key = doc_key.clone();
    let ask = StoredValue::new(move |spot: Spot, again: bool| {
        if question.get_untracked().is_some() || (!again && asked.with_value(|a| a.contains(&spot)))
        {
            return;
        }
        let Some(texts) = page_texts.get_untracked() else {
            return;
        };
        let secs = sections.get_untracked();
        let (from, to) = spot_pages(&secs, &spot, page_count.get_untracked());
        let pages: Vec<String> = texts
            .iter()
            .skip(from.saturating_sub(1) as usize)
            .take((to + 1).saturating_sub(from) as usize)
            .cloned()
            .collect();
        if pages.concat().trim().is_empty() {
            return;
        }
        let title = match &spot {
            Spot::Section(i) => secs.get(*i).map(|s| s.title.clone()).unwrap_or_default(),
            Spot::Page(_) => String::new(),
        };
        let about = if title.is_empty() {
            format!("page {from}")
        } else {
            title.clone()
        };
        asked.update_value(|a| {
            a.insert(spot.clone());
        });
        question.set(Some((
            about,
            question_request(&ask_key, &spot, &title, &pages),
        )));
    });
    let spot_now = move || {
        spot_at(
            &sections.get_untracked(),
            section_index.get_untracked(),
            position.get_untracked().page,
        )
    };
    Effect::new(move |before: Option<Option<usize>>| {
        let now = section_index.get();
        if restored.get_value() {
            if let Some(done) = section_finished(before.flatten(), now) {
                ask.with_value(|f| f(Spot::Section(done), false));
            }
        }
        now
    });
    let last_move = StoredValue::new(crate::js::now());
    let stall = set_interval_with_handle(
        move || {
            let quiet = panel.get_untracked() == "none"
                && define.get_untracked().is_none()
                && pending.get_untracked().is_none()
                && document().has_focus().unwrap_or(false);
            if !restored.get_value() || !quiet {
                last_move.set_value(crate::js::now());
            } else if crate::js::now() - last_move.get_value() >= QUESTION_STALL_MS {
                last_move.set_value(crate::js::now());
                ask.with_value(|f| f(spot_now(), false));
            }
        },
        std::time::Duration::from_secs(5),
    )
    .ok();
    on_cleanup(move || {
        if let Some(h) = stall {
            h.clear();
        }
    });

    // F toggles the focus line anywhere except text fields.
    let focus_line = Signal::derive(move || settings.get().reader_focus_line);
    // E opens the explain-back, Q asks a question about where you are now.
    let fkey = window_event_listener(leptos::ev::keydown, move |e| {
        let key = e.key();
        if e.meta_key() || e.ctrl_key() || e.alt_key() || is_typing_target(e.target()) {
            return;
        }
        if key == "e" {
            e.prevent_default();
            panel.update(|p| *p = if *p == "explain" { "none" } else { "explain" });
            return;
        }
        if key == "q" {
            e.prevent_default();
            ask.with_value(|f| f(spot_now(), true));
            return;
        }
        if key != "f" || e.meta_key() || e.ctrl_key() || e.alt_key() || is_typing_target(e.target())
        {
            return;
        }
        e.prevent_default();
        let on = !focus_line.get_untracked();
        leptos::task::spawn_local(
            async move { patch_settings("readerFocusLine", json!(on)).await },
        );
    });
    on_cleanup(move || fkey.remove());

    // Escape leaves note-placing mode and drops a waiting selection or definition.
    let esc = window_event_listener(leptos::ev::keydown, move |e| {
        if e.key() == "Escape" {
            note_mode.set(false);
            pending.set(None);
            define.set(None);
        }
    });
    on_cleanup(move || esc.remove());

    let awake = use_chrome_awake(Signal::derive(move || {
        panel.get() != "none" || note_mode.get() || outline_open.get()
    }));

    let initial = move || {
        hash_page.map(|p| (p, 0.0)).or_else(|| {
            paper
                .get_untracked()
                .and_then(|p| p.pdf.map(|d| (d.page, d.offset)))
        })
    };
    let src_error = src.clone();
    let explain_key = doc_key.clone();
    let toggle =
        move |name: &'static str| panel.update(|p| *p = if *p == name { "none" } else { name });

    view! {
        <div class="reader-root" data-chrome=move || if awake.get() { "awake" } else { "asleep" } data-focus-line=move || focus_line.get().then_some("true")>
            <ReaderToolbar
                title=title
                zoom=zoom
                has_outline=Signal::derive(move || matches!(load.get(), Load::Ready))
                outline_open=outline_open
                src=src.clone()
                note_mode=note_mode
                notes_open=Signal::derive(move || panel.get() == "notes")
                annotation_count=annotation_count
                on_toggle_notes=Callback::new(move |_| toggle("notes"))
                explain_open=Signal::derive(move || panel.get() == "explain")
                on_toggle_explain=Callback::new(move |_| toggle("explain"))
                find_open=Signal::derive(move || panel.get() == "find")
                on_toggle_find=Callback::new(move |_| toggle("find"))
            />
            <div class="reader-body">
                <Show when=move || matches!(load.get(), Load::Ready) && outline_open.get()>
                    <OutlineSidebar outline=outline.into() current_page=Signal::derive(move || position.get().page) on_jump=go />
                </Show>
                {move || match load.get() {
                    Load::Loading => view! {
                        <div class="reader-fallback" role="status" aria-live="polite">
                            <span class="reader-loading-spinner" aria-hidden="true"></span>
                            <p>"Preparing your document…"</p>
                        </div>
                    }
                    .into_any(),
                    Load::Error(message) => {
                        let url = src_error.clone();
                        view! {
                            <div class="reader-fallback">
                                <p>{message}</p>
                                <button class="fc-primary-btn" on:click=move |_| {
                                    let url = url.clone();
                                    leptos::task::spawn_local(async move { send(json!({ "type": "READER_OPEN_NATIVE", "url": url })).await; });
                                }>
                                    "Open in Chrome's viewer"
                                </button>
                            </div>
                        }
                        .into_any()
                    }
                    Load::Ready => ().into_any(),
                }}
                <Show when=move || matches!(load.get(), Load::Ready) && papers_loaded.get()>
                    // The cards float over the page column only, never over a side panel.
                    <div class="reader-main">
                        <PdfViewport
                            doc=doc
                            sizes=sizes.into()
                            zoom=zoom
                            initial=initial()
                            on_restored=Callback::new(move |_| {
                                if let Some(d) = paper.get_untracked().and_then(|p| p.pdf) {
                                    position.set(PdfPosition { page: d.page, offset: d.offset });
                                }
                                restored.set_value(true);
                            })
                            on_position=Callback::new(move |pos: PdfPosition| {
                                last_move.set_value(crate::js::now());
                                position.set(pos);
                                send_progress(false);
                            })
                            jump=jump
                            figures=figures.read_only()
                            on_text_click=on_text_click
                            page_extra=page_extra
                            on_scroll=Callback::new(move |_| {
                                pending.set(None);
                                define.set(None);
                            })
                        />
                        {move || pending.get().map(|p| view! { <SelectionMenu x=p.x y=p.y on_pick=pick_color /> })}
                        {
                            let doc_key = doc_key.clone();
                            move || define.get().map(|t| {
                                let (page, rects, word) = (t.page, t.rects.clone(), t.word.clone());
                                view! {
                                    <DefinePopover
                                        target=t
                                        doc_key=doc_key.clone()
                                        on_close=Callback::new(move |_| define.set(None))
                                        on_save=Callback::new(move |note: String| create_highlight(page, rects.clone(), word.clone(), DEFAULT_ANNOTATION_COLOR, note))
                                    />
                                }
                            })
                        }
                        <Show when=move || looks_scanned() && !scan_dismissed.get()>
                            <div class="reader-toast reader-scan-toast" role="status">
                                <span>"This looks like a scanned PDF. Search and highlighting may be limited until it has OCR text."</span>
                                <button type="button" on:click=move |_| scan_dismissed.set(true)>"Dismiss"</button>
                            </div>
                        </Show>
                        <Show when=move || note_mode.get()>
                            <div class="reader-toast reader-mode-banner" role="status">
                                <span>"Click anywhere on a page to place your note."</span>
                                <button type="button" on:click=move |_| note_mode.set(false)>"Cancel"</button>
                                <kbd>"Esc"</kbd>
                            </div>
                        </Show>
                        {move || question.get().map(|(about, request)| {
                                view! {
                                    <QuestionCard
                                        about=about
                                        request=request
                                        on_close=Callback::new(move |_| question.set(None))
                                        on_keep=Callback::new(move |note: String| {
                                            // A sticky at the reader's place on the page, holding question and answer.
                                            let pos = position.get_untracked();
                                            let mut draft = draft_base.with_value(|d| d(AnnotationKind::Sticky, pos.page, vec![], 0.92, pos.offset.clamp(0.02, 0.98)));
                                            draft.note = note;
                                            post(Message::AnnotAdd { draft });
                                        })
                                    />
                                }
                            })}
                        <Show when=move || focus_line.get()>
                            <div class="reader-focus-band" aria-hidden="true"></div>
                        </Show>
                        <Show when=move || !outline_open.get()>
                            <OutlineRail sections=sections current=section_index on_jump=go />
                        </Show>
                        <ReaderCapsule
                            label=capsule_label
                            message=section_toast
                            progress=progress
                            page=Signal::derive(move || position.get().page)
                            page_count=page_count
                            on_page_jump=go
                            zoom=zoom
                        />
                    </div>
                </Show>
                <Show when=move || matches!(load.get(), Load::Ready) && papers_loaded.get() && panel.get() == "notes">
                    <NotesSidebar annotations=doc_annotations.into() on_jump=Callback::new(move |(page, offset): (u32, f64)| {
                        jump_seq.update_value(|s| *s += 1);
                        set_jump.set(Some((page, offset, jump_seq.get_value())));
                    }) />
                </Show>
                <Show when=move || matches!(load.get(), Load::Ready) && panel.get() == "explain">
                    <ExplainPanel
                        doc_key=explain_key.clone()
                        page_texts=page_texts.into()
                        page_count=page_count
                        on_jump=go
                        on_close=Callback::new(move |_| panel.set("none"))
                    />
                </Show>
                <Show when=move || matches!(load.get(), Load::Ready) && panel.get() == "find">
                    <FindPanel pages=page_texts.into() on_jump=go on_close=Callback::new(move |_| panel.set("none")) />
                </Show>
            </div>
        </div>
    }
}

/// Single-key shortcuts must not fire while someone is typing.
fn is_typing_target(target: Option<web_sys::EventTarget>) -> bool {
    use wasm_bindgen::JsCast;
    let Some(el) = target.and_then(|t| t.dyn_into::<web_sys::HtmlElement>().ok()) else {
        return false;
    };
    el.is_content_editable() || matches!(el.tag_name().as_str(), "INPUT" | "TEXTAREA" | "SELECT")
}

/// Whether the toolbar shows: it sleeps after a moment of reading and wakes at
/// the top edge or on scroll-up. A pinned panel or reduced motion keeps it awake.
fn use_chrome_awake(pinned: Signal<bool>) -> Signal<bool> {
    let awake = RwSignal::new(true);
    let timer: StoredValue<Option<TimeoutHandle>, LocalStorage> = StoredValue::new_local(None);
    let reduced = window()
        .match_media("(prefers-reduced-motion: reduce)")
        .ok()
        .flatten()
        .is_some_and(|m| m.matches());
    let arm = move || {
        if let Some(h) = timer.try_update_value(Option::take).flatten() {
            h.clear();
        }
        if pinned.get_untracked() || reduced {
            return;
        }
        timer.set_value(
            set_timeout_with_handle(
                move || awake.set(false),
                std::time::Duration::from_millis(IDLE_MS),
            )
            .ok(),
        );
    };
    Effect::new(move |_| {
        pinned.get();
        awake.set(true);
        arm();
    });
    let moves = window_event_listener(leptos::ev::pointermove, move |e| {
        if e.client_y() <= WAKE_ZONE_PX {
            awake.set(true);
            arm();
        }
    });
    let wheel = window_event_listener(leptos::ev::wheel, move |e| {
        if e.delta_y() < 0.0 {
            awake.set(true);
            arm();
        }
    });
    on_cleanup(move || {
        moves.remove();
        wheel.remove();
    });
    awake.into()
}

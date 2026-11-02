//! The reader (src/pages/reader/Reader.tsx, PdfReader.tsx).

mod ui;
mod viewport;

use super::{patch_settings, send, use_settings, use_storage};
use crate::pdfjs::{self, PageSize};
use leptos::prelude::*;
use reader_core::figures::captions_from_lines;
use reader_core::outline::{heading_for_page, section_index_at, top_level, FlatOutlineItem};
use reader_core::papers::paper_match_key;
use reader_core::pdf::{reader_pdf_src, PdfPosition};
use reader_core::reading_aids::{minutes_left, time_left_label, word_counts};
use reader_core::types::{Annotation, Paper};
use serde_json::json;
use std::collections::HashMap;
use ui::{FindPanel, OutlineRail, OutlineSidebar, ReaderCapsule, ReaderToolbar};
use viewport::{Jump, PdfViewport};
use wasm_bindgen::JsValue;

/// One progress write at most every 5s; positions in between are dropped.
const PROGRESS_THROTTLE_MS: i64 = 5_000;
/// The toolbar sleeps after this long of reading, and wakes at the top edge or on scroll-up.
const IDLE_MS: u64 = 2500;
const WAKE_ZONE_PX: i32 = 48;

#[oxichrome::page(path = "src/pages/reader/index.html", title = "Reader", css = ["assets/theme.css", "assets/reader.css"])]
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
    let annotation_count = Signal::derive(move || {
        annotations.with(|a| a.iter().filter(|x| x.doc_key == doc_key).count())
    });

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

    // F toggles the focus line anywhere except text fields.
    let focus_line = Signal::derive(move || settings.get().reader_focus_line);
    let fkey = window_event_listener(leptos::ev::keydown, move |e| {
        if e.key() != "f"
            || e.meta_key()
            || e.ctrl_key()
            || e.alt_key()
            || is_typing_target(e.target())
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

    // Escape leaves note-placing mode.
    let esc = window_event_listener(leptos::ev::keydown, move |e| {
        if note_mode.get_untracked() && e.key() == "Escape" {
            note_mode.set(false);
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
                                position.set(pos);
                                send_progress(false);
                            })
                            jump=jump
                            figures=figures.read_only()
                        />
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

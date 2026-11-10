//! The reader's chrome.

use super::viewport::{ZOOM_MAX, ZOOM_MIN};
use crate::chrome;
use crate::pages::send;
use leptos::html;
use leptos::prelude::*;
use reader_core::constants::NEWTAB_PAGE_PATH;
use reader_core::find::{find_matches, MAX_MATCHES};
use reader_core::outline::{section_index_at, FlatOutlineItem};
use reader_core::pdf::alphaxiv_url;
use reader_core::reading_aids::{crossed_section, section_done_label};
use serde_json::json;
use wasm_bindgen::JsCast;

fn zoom_step(zoom: f64, by: f64) -> f64 {
    ((zoom + by) * 100.0).round() / 100.0
}

/// A 24-unit stroke icon, the toolbar's family.
#[component]
pub fn ToolbarIcon(children: Children) -> impl IntoView {
    view! {
        <svg aria-hidden="true" class="reader-toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            {children()}
        </svg>
    }
}

/// Close a popup on Escape or a pointerdown outside `root`.
fn close_on_outside(open: RwSignal<bool>, root: NodeRef<html::Div>) {
    let down = window_event_listener(leptos::ev::pointerdown, move |e| {
        if !open.get_untracked() {
            return;
        }
        let inside = root
            .get_untracked()
            .zip(e.target().and_then(|t| t.dyn_into::<web_sys::Node>().ok()))
            .is_some_and(|(r, t)| r.contains(Some(&t)));
        if !inside {
            open.set(false);
        }
    });
    let key = window_event_listener(leptos::ev::keydown, move |e| {
        if open.get_untracked() && e.key() == "Escape" {
            open.set(false);
        }
    });
    on_cleanup(move || {
        down.remove();
        key.remove();
    });
}

#[allow(clippy::too_many_arguments)]
#[component]
pub fn ReaderToolbar(
    title: Signal<String>,
    zoom: RwSignal<f64>,
    has_outline: Signal<bool>,
    outline_open: RwSignal<bool>,
    src: String,
    note_mode: RwSignal<bool>,
    notes_open: Signal<bool>,
    annotation_count: Signal<usize>,
    on_toggle_notes: Callback<()>,
    explain_open: Signal<bool>,
    on_toggle_explain: Callback<()>,
    find_open: Signal<bool>,
    on_toggle_find: Callback<()>,
    talk_open: Signal<bool>,
    on_toggle_talk: Callback<()>,
    listen_open: Signal<bool>,
    on_toggle_listen: Callback<()>,
) -> impl IntoView {
    let more_open = RwSignal::new(false);
    let more: NodeRef<html::Div> = NodeRef::new();
    close_on_outside(more_open, more);

    // ⌘F opens find; ⌘+ / ⌘− / ⌘0 zoom the page, never the chrome around it.
    let keys = window_event_listener(leptos::ev::keydown, move |e| {
        if !(e.meta_key() || e.ctrl_key()) || e.alt_key() {
            return;
        }
        match e.key().to_lowercase().as_str() {
            "f" => {
                e.prevent_default();
                if !find_open.get_untracked() {
                    on_toggle_find.run(());
                }
            }
            "=" | "+" => {
                e.prevent_default();
                zoom.update(|z| *z = zoom_step(*z, 0.25).min(ZOOM_MAX));
            }
            "-" => {
                e.prevent_default();
                zoom.update(|z| *z = zoom_step(*z, -0.25).max(ZOOM_MIN));
            }
            "0" => {
                e.prevent_default();
                zoom.set(1.0);
            }
            _ => {}
        }
    });
    on_cleanup(move || keys.remove());

    let alphaxiv = alphaxiv_url(&src);
    let src_native = src.clone();
    let active = |on: bool, base: &'static str| {
        if on {
            format!("{base} active")
        } else {
            base.to_string()
        }
    };

    view! {
        <header class="reader-toolbar">
            <div class="reader-toolbar-left">
                <button class="reader-icon-btn" aria-label="Back to Today" title="Back to Today" on:click=|_| {
                    let _ = window().location().set_href(&chrome::get_url(NEWTAB_PAGE_PATH));
                }>
                    <ToolbarIcon><path d="m15 18-6-6 6-6" /></ToolbarIcon>
                </button>
                <Show when=move || has_outline.get()>
                    <button
                        class=move || active(outline_open.get(), "reader-icon-btn")
                        aria-label=move || if outline_open.get() { "Hide sidebar" } else { "Show sidebar" }
                        aria-pressed=move || outline_open.get().to_string()
                        title=move || if outline_open.get() { "Hide sidebar" } else { "Show sidebar" }
                        on:click=move |_| outline_open.update(|o| *o = !*o)
                    >
                        <ToolbarIcon>
                            <rect x="3.5" y="4" width="17" height="16" rx="2" />
                            <path d="M9 4v16" />
                        </ToolbarIcon>
                    </button>
                </Show>
                <div class="reader-document-title">
                    <h1 title=title class="reader-title">{title}</h1>
                    <span>"PDF document"</span>
                </div>
            </div>

            <div class="reader-toolbar-right">
                <button
                    class=move || active(explain_open.get(), "ghost-btn reader-explain-btn")
                    aria-pressed=move || explain_open.get().to_string()
                    aria-keyshortcuts="E"
                    title="Explain the paper back in your own words (E)"
                    on:click=move |_| on_toggle_explain.run(())
                >
                    "Explain it back"
                </button>
                <button
                    class=move || active(talk_open.get(), "ghost-btn reader-explain-btn")
                    aria-pressed=move || talk_open.get().to_string()
                    title="Talk the paper through out loud; it asks, never explains"
                    on:click=move |_| on_toggle_talk.run(())
                >
                    "Talk it through"
                </button>
                <button
                    class=move || active(listen_open.get(), "ghost-btn reader-explain-btn")
                    aria-pressed=move || listen_open.get().to_string()
                    title="Read the paper aloud from this page, explaining the math"
                    on:click=move |_| on_toggle_listen.run(())
                >
                    "Listen"
                </button>
                <button
                    class=move || active(find_open.get(), "reader-icon-btn")
                    aria-label="Find in document"
                    aria-pressed=move || find_open.get().to_string()
                    title="Find in document (⌘F)"
                    on:click=move |_| on_toggle_find.run(())
                >
                    <ToolbarIcon>
                        <circle cx="11" cy="11" r="6.5" />
                        <path d="m16 16 4 4" />
                    </ToolbarIcon>
                </button>
                <button
                    class=move || active(note_mode.get(), "reader-icon-btn")
                    aria-label=move || if note_mode.get() { "Cancel note placement" } else { "Add a note" }
                    aria-pressed=move || note_mode.get().to_string()
                    title=move || if note_mode.get() { "Cancel note placement (Esc)" } else { "Add a note" }
                    on:click=move |_| note_mode.update(|n| *n = !*n)
                >
                    <ToolbarIcon>
                        <path d="M5 4.5h10a2 2 0 0 1 2 2V14l-5 5H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2Z" />
                        <path d="M12 19v-3a2 2 0 0 1 2-2h3M8 9h4M10 7v4" />
                    </ToolbarIcon>
                </button>
                <button
                    class=move || if notes_open.get() { "reader-icon-btn active reader-badged-btn" } else { "reader-icon-btn reader-badged-btn" }
                    aria-label=move || {
                        let n = annotation_count.get();
                        if n > 0 { format!("Show highlights and notes, {n}") } else { "Show highlights and notes".to_string() }
                    }
                    aria-pressed=move || notes_open.get().to_string()
                    title="Show highlights and notes"
                    on:click=move |_| on_toggle_notes.run(())
                >
                    <ToolbarIcon>
                        <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 3v-14a2 2 0 0 1 2-2Z" />
                        <path d="M8 9h8M8 13h6" />
                    </ToolbarIcon>
                    {move || { let n = annotation_count.get(); (n > 0).then(|| view! { <span class="reader-toolbar-badge">{n}</span> }) }}
                </button>
                <div class="reader-more" node_ref=more>
                    <button
                        class=move || active(more_open.get(), "reader-icon-btn")
                        aria-label="More reader options"
                        aria-haspopup="menu"
                        aria-expanded=move || more_open.get().to_string()
                        title="More reader options"
                        on:click=move |_| more_open.update(|o| *o = !*o)
                    >
                        <ToolbarIcon>
                            <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
                            <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
                            <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
                        </ToolbarIcon>
                    </button>
                    <Show when=move || more_open.get()>
                        <div class="reader-more-menu" role="menu">
                            {alphaxiv.clone().map(|url| view! {
                                <button role="menuitem" on:click=move |_| {
                                    more_open.set(false);
                                    let _ = window().location().assign(&url);
                                }>
                                    <ToolbarIcon>
                                        <path d="M14 4h6v6M20 4l-9 9" />
                                        <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
                                    </ToolbarIcon>
                                    <span>"Open in alphaXiv"</span>
                                </button>
                            })}
                            {
                                let url = src_native.clone();
                                view! {
                                    <button role="menuitem" on:click=move |_| {
                                        more_open.set(false);
                                        let url = url.clone();
                                        leptos::task::spawn_local(async move { send(json!({ "type": "READER_OPEN_NATIVE", "url": url })).await; });
                                    }>
                                        <ToolbarIcon>
                                            <path d="M14 4h6v6M20 4l-9 9" />
                                            <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
                                        </ToolbarIcon>
                                        <span>"Open in Chrome"</span>
                                    </button>
                                }
                            }
                        </div>
                    </Show>
                </div>
            </div>
        </header>
    }
}

/// Where you are and how long is left, floating under the page; click for
/// page jump and zoom. Carries the quiet announcements (a section finished).
#[component]
pub fn ReaderCapsule(
    label: Signal<String>,
    progress: Signal<f64>,
    page: Signal<u32>,
    page_count: Signal<u32>,
    on_page_jump: Callback<u32>,
    zoom: RwSignal<f64>,
    message: Signal<Option<String>>,
) -> impl IntoView {
    let open = RwSignal::new(false);
    let root: NodeRef<html::Div> = NodeRef::new();
    close_on_outside(open, root);
    // While the controls are open, announcements wait: swapping them in would unmount the focused control.
    let shown = move || if open.get() { None } else { message.get() };
    let draft = RwSignal::new(String::new());
    Effect::new(move |_| draft.set(page.get().to_string()));
    let jump_to_draft = move || match draft.get_untracked().parse::<u32>() {
        Ok(n) if n >= 1 && n <= page_count.get_untracked() => on_page_jump.run(n),
        _ => draft.set(page.get_untracked().to_string()),
    };

    view! {
        <div class="reader-progress-line" style:transform=move || format!("scaleX({})", progress.get().clamp(0.0, 1.0)) aria-hidden="true"></div>
        <div node_ref=root class="reader-capsule" data-open=move || open.get().then_some("true") data-message=move || shown().map(|_| "")>
            // Always mounted, so a message arriving later is announced.
            <span class="reader-capsule-message" role="status" aria-live="polite">{move || shown().unwrap_or_default()}</span>
            {move || {
                if shown().is_some() {
                    return ().into_any();
                }
                if !open.get() {
                    return view! {
                        <button type="button" class="reader-capsule-summary" aria-expanded="false" aria-label=move || format!("{}. Open page and zoom controls", label.get()) on:click=move |_| open.set(true)>
                            <span class="reader-capsule-dot" aria-hidden="true"></span>
                            {label}
                        </button>
                    }
                    .into_any();
                }
                view! {
                    <Show when=move || { page_count.get() > 0 }>
                        <div class="reader-toolbar-group reader-pagination" aria-label="Page navigation">
                            <button class="reader-icon-btn" aria-label="Previous page" title="Previous page" disabled={move || page.get() <= 1} on:click=move |_| on_page_jump.run(page.get_untracked() - 1)>
                                <ToolbarIcon><path d="m14 17-5-5 5-5" /></ToolbarIcon>
                            </button>
                            <label class="reader-page-jump" title="Go to page">
                                <input
                                    aria-label="Go to page"
                                    inputmode="numeric"
                                    prop:value=move || draft.get()
                                    on:input=move |e| draft.set(event_target_value(&e))
                                    on:blur=move |_| jump_to_draft()
                                    on:keydown=move |e| {
                                        let el = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlElement>().ok());
                                        if e.key() == "Enter" {
                                            if let Some(el) = el { let _ = el.blur(); }
                                        } else if e.key() == "Escape" {
                                            draft.set(page.get_untracked().to_string());
                                            if let Some(el) = el { let _ = el.blur(); }
                                        }
                                    }
                                />
                                <span>"of "{page_count}</span>
                            </label>
                            <button class="reader-icon-btn" aria-label="Next page" title="Next page" disabled={move || page.get() >= page_count.get()} on:click=move |_| on_page_jump.run(page.get_untracked() + 1)>
                                <ToolbarIcon><path d="m10 17 5-5-5-5" /></ToolbarIcon>
                            </button>
                        </div>
                    </Show>
                    <div class="reader-toolbar-group reader-zoom-controls" aria-label="Zoom controls">
                        <button class="reader-icon-btn" aria-label="Zoom out" title="Zoom out (⌘−)" disabled={move || zoom.get() <= ZOOM_MIN} on:click=move |_| zoom.update(|z| *z = zoom_step(*z, -0.25).max(ZOOM_MIN))>
                            <ToolbarIcon><path d="M7 12h10" /></ToolbarIcon>
                        </button>
                        <button class="reader-zoom-value" title="Fit width (⌘0)" on:click=move |_| zoom.set(1.0)>{move || format!("{}%", (zoom.get() * 100.0).round())}</button>
                        <button class="reader-icon-btn" aria-label="Zoom in" title="Zoom in (⌘+)" disabled={move || zoom.get() >= ZOOM_MAX} on:click=move |_| zoom.update(|z| *z = zoom_step(*z, 0.25).min(ZOOM_MAX))>
                            <ToolbarIcon><path d="M12 7v10M7 12h10" /></ToolbarIcon>
                        </button>
                    </div>
                }
                .into_any()
            }}
        </div>
    }
}

/// The outline folded to tick marks on the left edge.
#[component]
pub fn OutlineRail(
    sections: Signal<Vec<FlatOutlineItem>>,
    current: Signal<Option<usize>>,
    on_jump: Callback<u32>,
) -> impl IntoView {
    move || {
        let list = sections.get();
        (!list.is_empty()).then(|| view! {
            <nav class="reader-rail" aria-label="Sections">
                <ol>
                    {list.into_iter().enumerate().map(|(i, s)| {
                        let state = move || match current.get() {
                            Some(c) if i < c => Some("done"),
                            Some(c) if i == c => Some("current"),
                            _ => None,
                        };
                        let page = s.page;
                        // The label is hidden at rest, which takes it out of the accessibility tree too.
                        let name = s.title.clone();
                        view! {
                            <li>
                                <button type="button" class="reader-rail-tick" data-state=state aria-label=name aria-current=move || (current.get() == Some(i)).then_some("location") on:click=move |_| on_jump.run(page)>
                                    <span class="reader-rail-label">{s.title}</span>
                                </button>
                            </li>
                        }
                    }).collect_view()}
                </ol>
            </nav>
        })
    }
}

/// "Section 3 done · 2 left" for three seconds after reading into the next section.
pub fn use_section_toast(
    sections: Signal<Vec<FlatOutlineItem>>,
    current: Signal<Option<usize>>,
) -> Signal<Option<String>> {
    let toast = RwSignal::new(None::<String>);
    let prev = StoredValue::new(None::<usize>);
    let mounted_at = crate::js::now();
    let timer: StoredValue<Option<TimeoutHandle>, LocalStorage> = StoredValue::new_local(None);
    Effect::new(move |_| {
        let c = current.get();
        let as_i = |x: Option<usize>| x.map_or(-1, |v| v as i32);
        let finished = crossed_section(as_i(prev.get_value()), as_i(c));
        prev.set_value(c);
        // A time guard: reopening a paper scrolls to where you were, which can cross one section. That is not reading.
        let Some(done) = finished.filter(|_| crate::js::now() - mounted_at >= 3000) else {
            return;
        };
        toast.set(Some(section_done_label(
            done,
            sections.with_untracked(Vec::len) as i32,
        )));
        if let Some(h) = timer.try_update_value(Option::take).flatten() {
            h.clear();
        }
        timer.set_value(
            set_timeout_with_handle(move || toast.set(None), std::time::Duration::from_secs(3))
                .ok(),
        );
    });
    toast.into()
}

#[component]
pub fn OutlineSidebar(
    outline: Signal<Vec<FlatOutlineItem>>,
    current_page: Signal<u32>,
    on_jump: Callback<u32>,
) -> impl IntoView {
    let active = move || section_index_at(&outline.get(), current_page.get());
    view! {
        <nav class="reader-outline" aria-label="Outline">
            <h2>"Outline"</h2>
            {move || outline.get().is_empty().then(|| view! { <p class="reader-notes-empty">"This paper has no outline."</p> })}
            {move || {
                let list = outline.get();
                (!list.is_empty()).then(|| view! {
                    <ul>
                        {list.into_iter().enumerate().map(|(i, item)| {
                            let page = item.page;
                            view! {
                                <li>
                                    <button
                                        class=move || if active() == Some(i) { "reader-outline-item active" } else { "reader-outline-item" }
                                        style:padding-left=format!("{}px", 10 + item.level * 14)
                                        title=item.title.clone()
                                        on:click=move |_| on_jump.run(page)
                                    >
                                        {item.title.clone()}
                                    </button>
                                </li>
                            }
                        }).collect_view()}
                    </ul>
                })
            }}
        </nav>
    }
}

#[component]
pub fn FindPanel(
    pages: Signal<Option<Vec<String>>>,
    on_jump: Callback<u32>,
    on_close: Callback<()>,
) -> impl IntoView {
    let query = RwSignal::new(String::new());
    let matches = Memo::new(move |_| {
        pages.with(|p| {
            p.as_ref()
                .map(|p| find_matches(p, &query.get()))
                .unwrap_or_default()
        })
    });
    view! {
        <aside class="reader-find" aria-label="Find in paper">
            <div class="reader-related-head">
                <h2>"Find in paper"</h2>
                <button class="ghost-btn" on:click=move |_| on_close.run(()) aria-label="Close find">"✕"</button>
            </div>
            <input class="reader-find-input" autofocus prop:value=move || query.get() on:input=move |e| query.set(event_target_value(&e)) placeholder="Search text" />
            {move || {
                if pages.with(Option::is_none) {
                    Some(view! { <p class="reader-notes-empty">"Indexing text…"</p> }.into_any())
                } else if !query.get().trim().is_empty() {
                    let n = matches.with(Vec::len);
                    let text = if n == 0 { "No matches.".to_string() } else { format!("{n}{} pages found", if n == MAX_MATCHES { "+" } else { "" }) };
                    Some(view! { <p class="reader-notes-empty">{text}</p> }.into_any())
                } else {
                    None
                }
            }}
            <ul class="reader-find-results">
                {move || matches.get().into_iter().map(|m| {
                    let page = m.page as u32;
                    view! { <li><button on:click=move |_| on_jump.run(page)><strong>"Page "{m.page}</strong><span>{m.excerpt}</span></button></li> }
                }).collect_view()}
            </ul>
        </aside>
    }
}

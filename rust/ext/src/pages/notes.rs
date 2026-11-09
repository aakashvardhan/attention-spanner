//! The Notes page: every YouTube video with saved takeaways (videoNotes),
//! newest first; pick one to read its notes here, each moment a link back
//! into the video. `#<video id>` opens straight to one.

use super::notes_view::NotesView;
use super::use_storage;
use crate::js::local_date;
use leptos::prelude::*;
use reader_core::youtube::VideoNotes;
use std::collections::BTreeMap;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

fn hash_id() -> Option<String> {
    let h = web_sys::window()?.location().hash().ok()?;
    let id = h.trim_start_matches('#');
    (!id.is_empty()).then(|| id.to_string())
}

#[oxichrome::page(path = "src/pages/notes/index.html", title = "Notes", css = ["assets/theme.css", "assets/sidebar.css", "assets/notes.css"])]
pub fn Notes() -> impl IntoView {
    super::use_theme();
    let (all, loaded) = use_storage::<BTreeMap<String, VideoNotes>>("videoNotes");
    let list = Memo::new(move |_| {
        let mut v: Vec<VideoNotes> = all.get().into_values().collect();
        v.sort_by_key(|n| std::cmp::Reverse(n.created_at));
        v
    });
    let chosen = RwSignal::new(hash_id());
    // Back, forward, or an edited #id: show what the address says.
    let on_hash = Closure::<dyn FnMut()>::new(move || chosen.set(hash_id()));
    if let Some(w) = web_sys::window() {
        let _ = w.add_event_listener_with_callback("hashchange", on_hash.as_ref().unchecked_ref());
    }
    // The page lives as long as its listener.
    on_hash.forget();
    let pick = move |id: String| {
        if let Some(w) = web_sys::window() {
            let _ = w.location().set_hash(&id);
        }
        chosen.set(Some(id));
    };
    let shown = Memo::new(move |_| {
        let id = chosen.get()?;
        list.with(|l| l.iter().find(|n| n.id == id).cloned())
    });

    view! {
        <main class="notes-page">
            <h1 class="notes-page-title">"Notes"</h1>
            {move || {
                if !loaded.get() {
                    return ().into_any();
                }
                if list.with(Vec::is_empty) {
                    return view! {
                        <p class="sidebar-quiet">"No notes yet. Open a YouTube video, click the Reader icon, and press Take notes."</p>
                    }.into_any();
                }
                view! {
                    <div class="notes-layout">
                        <nav aria-label="Videos">
                            <ul class="notes-list">
                                {move || list.get().into_iter().map(|n| {
                                    let id = n.id.clone();
                                    let current = {
                                        let id = id.clone();
                                        move || chosen.with(|c| c.as_deref() == Some(id.as_str()))
                                    };
                                    let d = local_date(n.created_at);
                                    view! {
                                        <li>
                                            <button type="button" aria-current=move || current().then_some("true") on:click=move |_| pick(id.clone())>
                                                <strong>{n.title.clone()}</strong>
                                                <span>{format!("{} · {}-{:02}-{:02}", n.kind.label(), d.year, d.month, d.day)}</span>
                                            </button>
                                        </li>
                                    }
                                }).collect_view()}
                            </ul>
                        </nav>
                        <article class="notes-reading">
                            {move || match shown.get() {
                                None => view! { <p class="sidebar-quiet">"Pick a video to read its notes."</p> }.into_any(),
                                Some(n) => view! {
                                    <h2>{n.title.clone()}</h2>
                                    <a class="ghost-btn" href=reader_core::youtube::watch_url(&n.id) target="_blank" rel="noopener">"Watch on YouTube"</a>
                                    <NotesView notes=n on_seek=None />
                                }.into_any(),
                            }}
                        </article>
                    </div>
                }.into_any()
            }}
        </main>
    }
}

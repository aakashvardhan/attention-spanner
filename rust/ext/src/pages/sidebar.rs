//! The side panel the toolbar icon opens. It reads the active tab's main text
//! and offers the reader's Listen and Talk it through for it. Nothing is
//! kept: when the tab goes somewhere else the panels are rebuilt for the new
//! page, which stops their audio and drops their conversation.

use super::reader::listen::ListenPanel;
use super::reader::talk::TalkPanel;
use crate::chrome;
use crate::js::{from_js, to_js, wait};
use crate::page_text::{self, PageText, UNREADABLE};
use leptos::prelude::*;
use reader_core::voice_agent::Source;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[derive(Debug, Clone, PartialEq)]
struct Target {
    tab_id: i32,
    url: String,
    text: Result<PageText, String>,
}

fn query_param(name: &str) -> Option<String> {
    let search = web_sys::window()?.location().search().ok()?;
    url::form_urlencoded::parse(search.trim_start_matches('?').as_bytes())
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// The tab as `{ id, url, status }`; `url` is missing where the extension
/// may not see it (other extensions' pages).
async fn tab(pinned: Option<i32>) -> Option<Value> {
    let found = match pinned {
        Some(id) => wait(chrome::tabs_get(id)).await.ok()?,
        None => {
            let query = to_js(&json!({ "active": true, "currentWindow": true })).ok()?;
            let tabs: Vec<Value> = from_js(wait(chrome::tabs_query(&query)).await.ok()?).ok()?;
            return tabs.into_iter().next();
        }
    };
    from_js(found).ok()
}

#[oxichrome::page(path = "src/pages/sidebar/index.html", title = "Reader", css = ["assets/theme.css", "assets/reader.css", "assets/aiNote.css", "assets/markdown.css", "assets/sidebar.css"])]
pub fn Sidebar() -> impl IntoView {
    super::use_theme();
    if query_param("mic").is_some() {
        return view! { <MicGrant /> }.into_any();
    }
    // ?tab=<id> pins the panel to one tab (the e2e suite opens it as a tab).
    let pinned = query_param("tab").and_then(|t| t.parse::<i32>().ok());
    let target = RwSignal::new(None::<Target>);
    let generation = StoredValue::new(0u64);
    // The tab being followed; outlives `target`, which is cleared mid-navigation.
    let following = StoredValue::new(pinned);

    let load = move || {
        generation.update_value(|g| *g += 1);
        let mine = generation.get_value();
        leptos::task::spawn_local(async move {
            let Some(t) = tab(pinned).await else { return };
            let tab_id = t["id"].as_i64().unwrap_or_default() as i32;
            following.set_value(Some(tab_id));
            let url = t["url"].as_str().unwrap_or_default().to_string();
            if target.with_untracked(|c| {
                c.as_ref()
                    .is_some_and(|c| c.tab_id == tab_id && c.url == url)
            }) {
                return;
            }
            let text = if url.starts_with("http://") || url.starts_with("https://") {
                page_text::read(tab_id).await
            } else {
                Err(UNREADABLE.to_string())
            };
            if generation.get_value() == mine {
                target.set(Some(Target { tab_id, url, text }));
            }
        });
    };
    load();

    if pinned.is_none() {
        let activated = Closure::<dyn FnMut(JsValue)>::new(move |_| load());
        chrome::tabs_on_activated(&activated);
        activated.forget();
    }
    let updated = Closure::<dyn FnMut(i32, JsValue, JsValue)>::new(
        move |tab_id: i32, info: JsValue, tab: JsValue| {
            if following.get_value() != Some(tab_id) {
                return;
            }
            let info: Value = from_js(info).unwrap_or_default();
            let tab: Value = from_js(tab).unwrap_or_default();
            let moved = info["url"]
                .as_str()
                .is_some_and(|u| target.with_untracked(|t| t.as_ref().is_some_and(|t| t.url != u)));
            // Going somewhere else: drop the old page now (its audio stops),
            // and read the new one once it has loaded.
            if moved {
                target.set(None);
            }
            if tab["status"] == "complete" || info["status"] == "complete" {
                load();
            }
        },
    );
    chrome::tabs_on_updated(&updated);
    updated.forget();

    view! {
        <main class="sidebar">
            {move || match target.get() {
                None => view! { <p class="sidebar-quiet" role="status">"Reading the page…"</p> }.into_any(),
                Some(Target { text: Err(m), .. }) => view! { <p class="sidebar-quiet" role="status">{m}</p> }.into_any(),
                Some(Target { text: Ok(page), .. }) => view! { <PagePanels page=page /> }.into_any(),
            }}
        </main>
    }
    .into_any()
}

#[component]
fn PagePanels(page: PageText) -> impl IntoView {
    let mode = RwSignal::new("listen");
    let title = Signal::stored(page.title.clone());
    let texts = Signal::stored(Some(page.sections));
    let none = Callback::new(|_: ()| {});
    let open_mic = move |_| {
        if let Ok(props) =
            to_js(&json!({ "url": chrome::get_url("src/pages/sidebar/index.html?mic=1") }))
        {
            let _ = chrome::tabs_create(&props);
        }
    };
    view! {
        <h1 class="sidebar-title">{page.title}</h1>
        <div class="sidebar-switch" role="group" aria-label="Mode">
            <button type="button" aria-pressed=move || (mode.get() == "listen").to_string() on:click=move |_| mode.set("listen")>"Listen"</button>
            <button type="button" aria-pressed=move || (mode.get() == "talk").to_string() on:click=move |_| mode.set("talk")>"Talk it through"</button>
        </div>
        {move || if mode.get() == "listen" {
            view! {
                <ListenPanel title=title source=Source::Webpage doc=None page_texts=texts page=Signal::stored(1) on_jump=None on_close=none />
            }.into_any()
        } else {
            view! {
                <TalkPanel title=title source=Source::Webpage page_texts=texts page=Signal::stored(1) on_close=none />
                <p class="sidebar-quiet">
                    "Mic blocked in the side panel? "
                    <button type="button" class="ghost-btn" on:click=open_mic>"Allow the microphone"</button>
                </p>
            }.into_any()
        }}
    }
}

/// Opened in a tab from the side panel: a tab can ask for the microphone
/// where the side panel may not, and the grant then holds for the panel too.
#[component]
fn MicGrant() -> impl IntoView {
    let said = RwSignal::new("Asking for the microphone…".to_string());
    leptos::task::spawn_local(async move {
        let Some(devices) = web_sys::window().and_then(|w| w.navigator().media_devices().ok())
        else {
            said.set("This browser has no mic access.".into());
            return;
        };
        let Ok(constraints) = to_js(&json!({ "audio": true })) else {
            return;
        };
        match wait(devices.get_user_media_with_constraints(constraints.unchecked_ref())).await {
            Ok(stream) => {
                let stream: web_sys::MediaStream = stream.unchecked_into();
                for t in stream.get_tracks() {
                    t.unchecked_into::<web_sys::MediaStreamTrack>().stop();
                }
                said.set("Microphone allowed. Close this tab and press Start talking.".into());
            }
            Err(e) => said.set(crate::voice::mic_error(&e)),
        }
    });
    view! {
        <main class="sidebar">
            <h1 class="sidebar-title">"Microphone"</h1>
            <p class="sidebar-quiet" role="status">{move || said.get()}</p>
        </main>
    }
}

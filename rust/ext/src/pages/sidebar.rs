//! The side panel the toolbar icon opens. It reads the active tab's main text
//! and offers the reader's Listen and Talk it through for it. Nothing is
//! kept: when the tab goes somewhere else the panels are rebuilt for the new
//! page, which stops their audio and drops their conversation.

use super::reader::listen::ListenPanel;
use super::reader::talk::TalkPanel;
use super::video_panel::VideoPanel;
use crate::chrome;
use crate::js::{from_js, to_js, wait};
use crate::page_text::{self, PageText, UNREADABLE};
use crate::voice::sleep_ms;
use leptos::prelude::*;
use reader_core::voice_agent::Source;
use reader_core::youtube;
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[derive(Debug, Clone, PartialEq)]
enum Content {
    /// Any page: its text, or why it can't be read.
    Page(Result<PageText, String>),
    /// A YouTube video: notes instead of the page's text.
    Video { id: String },
}

#[derive(Debug, Clone, PartialEq)]
struct Target {
    tab_id: i32,
    url: String,
    content: Content,
}

fn query_param(name: &str) -> Option<String> {
    let search = web_sys::window()?.location().search().ok()?;
    url::form_urlencoded::parse(search.trim_start_matches('?').as_bytes())
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// What makes two URLs the same page: a video is its id (a start time or
/// playlist position is the same video); any other page is its URL without
/// the `#fragment` (jumping to an anchor is the same page).
fn page_of(url: &str) -> String {
    youtube::video_id(url)
        .map(|id| format!("youtube:{id}"))
        .unwrap_or_else(|| url.split('#').next().unwrap_or(url).to_string())
}

/// After a single-page app changes its URL it draws the new page; read after this.
const SPA_SETTLE_MS: i32 = 1_000;
/// A page that never finishes loading (a hung image) is read anyway after this.
const LOAD_FALLBACK_MS: i32 = 10_000;

/// The tab as `{ id, windowId, url, status }`; `url` is missing where the
/// extension may not see it (other extensions' pages). `pinned` is a tab;
/// else the active tab of `window` (the panel's own window when `None`).
async fn tab(pinned: Option<i32>, window: Option<i32>) -> Option<Value> {
    let found = match pinned {
        Some(id) => wait(chrome::tabs_get(id)).await.ok()?,
        None => {
            let query = match window {
                Some(w) => json!({ "active": true, "windowId": w }),
                None => json!({ "active": true, "currentWindow": true }),
            };
            let query = to_js(&query).ok()?;
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
    // ?window=<id> follows that window's active tab (e2e: the real following path).
    let window = query_param("window").and_then(|t| t.parse::<i32>().ok());
    let target = RwSignal::new(None::<Target>);
    // A video's title as the tab shows it: YouTube changes the URL before the
    // title, so it follows the tab's title changes without rebuilding the panel.
    let video_title = RwSignal::new(String::new());
    let generation = StoredValue::new(0u64);
    // The tab being followed; outlives `target`, which is cleared mid-navigation.
    let following = StoredValue::new(pinned);
    // Its window: tab switches in other windows are not ours.
    let following_window = StoredValue::new(window);
    // Until when a "complete" is too early to read (just after a URL change).
    let settle_until = StoredValue::new(0i64);

    let load = move || {
        generation.update_value(|g| *g += 1);
        let mine = generation.get_value();
        leptos::task::spawn_local(async move {
            let Some(t) = tab(pinned, window).await else {
                return;
            };
            let tab_id = t["id"].as_i64().unwrap_or_default() as i32;
            following.set_value(Some(tab_id));
            following_window.set_value(t["windowId"].as_i64().map(|w| w as i32));
            let url = t["url"].as_str().unwrap_or_default().to_string();
            // Already showing this page, read: keep it (and its audio). A
            // failed read is tried again.
            let same = |c: &Target| {
                c.tab_id == tab_id
                    && page_of(&c.url) == page_of(&url)
                    && !matches!(c.content, Content::Page(Err(_)))
            };
            if target.with_untracked(|c| c.as_ref().is_some_and(same)) {
                return;
            }
            let content = if let Some(id) = youtube::video_id(&url) {
                let title = t["title"].as_str().unwrap_or_default();
                let title = title
                    .strip_suffix(" - YouTube")
                    .unwrap_or(title)
                    .to_string();
                video_title.set(title);
                Content::Video { id }
            } else if url.starts_with("http://") || url.starts_with("https://") {
                Content::Page(page_text::read(tab_id).await)
            } else {
                Content::Page(Err(UNREADABLE.to_string()))
            };
            if generation.get_value() == mine {
                target.set(Some(Target {
                    tab_id,
                    url,
                    content,
                }));
            }
        });
    };
    load();

    if pinned.is_none() {
        // Another tab: the old page goes at once (its audio stops), not
        // once the new one has been read.
        let activated = Closure::<dyn FnMut(JsValue)>::new(move |info: JsValue| {
            let info: Value = from_js(info).unwrap_or_default();
            let theirs = info["windowId"].as_i64().map(|w| w as i32);
            if following_window.get_value().is_some() && theirs != following_window.get_value() {
                return;
            }
            target.set(None);
            load();
        });
        chrome::tabs_on_activated(&activated);
        activated.forget();
    }
    let updated = Closure::<dyn FnMut(i32, JsValue, JsValue)>::new(
        move |tab_id: i32, info: JsValue, _tab: JsValue| {
            if following.get_value() != Some(tab_id) {
                return;
            }
            let info: Value = from_js(info).unwrap_or_default();
            let on_video = target.with_untracked(|t| {
                t.as_ref()
                    .is_some_and(|t| matches!(t.content, Content::Video { .. }))
            });
            if let (true, Some(title)) = (on_video, info["title"].as_str()) {
                video_title.set(
                    title
                        .strip_suffix(" - YouTube")
                        .unwrap_or(title)
                        .to_string(),
                );
            }
            let moved = info["url"].as_str().is_some_and(|u| {
                target.with_untracked(|t| t.as_ref().is_some_and(|t| page_of(&t.url) != page_of(u)))
            });
            // Going somewhere else: drop the old page now (its audio stops).
            // Read the new one a moment later: a single-page app changes its
            // URL (and Chrome may already say "complete") before it draws
            // the new page. A page that never finishes loading is read anyway.
            if moved {
                target.set(None);
                settle_until.set_value(crate::js::now() + i64::from(SPA_SETTLE_MS));
                leptos::task::spawn_local(async move {
                    sleep_ms(SPA_SETTLE_MS).await;
                    load();
                    sleep_ms(LOAD_FALLBACK_MS).await;
                    if target.with_untracked(Option::is_none) {
                        load();
                    }
                });
            } else if info["status"] == "complete" && crate::js::now() >= settle_until.get_value() {
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
                Some(Target { content: Content::Page(Err(m)), .. }) => view! { <p class="sidebar-quiet" role="status">{m}</p> }.into_any(),
                Some(Target { content: Content::Page(Ok(page)), .. }) => view! { <PagePanels page=page /> }.into_any(),
                Some(Target { tab_id, content: Content::Video { id }, .. }) => view! { <VideoPanel tab_id=tab_id id=id title=video_title.into() /> }.into_any(),
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
                <MicHelp />
            }.into_any()
        }}
    }
}

/// The side panel may not be allowed to ask for the mic: a tab can.
#[component]
pub fn MicHelp() -> impl IntoView {
    let open_mic = move |_| {
        if let Ok(props) =
            to_js(&json!({ "url": chrome::get_url("src/pages/sidebar/index.html?mic=1") }))
        {
            let _ = chrome::tabs_create(&props);
        }
    };
    view! {
        <p class="sidebar-quiet">
            "Mic blocked in the side panel? "
            <button type="button" class="ghost-btn" on:click=open_mic>"Allow the microphone"</button>
        </p>
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

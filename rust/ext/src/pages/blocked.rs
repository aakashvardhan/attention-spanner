//! Shown when a blocked site is hit while a paper is open in the reader
//! (src/pages/blocked/Blocked.tsx). Renders from storage only: when the
//! session ends, the page turns into a "continue" link by itself.

use super::{send, use_storage};
use leptos::prelude::*;
use reader_core::pomodoro::{is_focus, Pomodoro};
use reader_core::types::FocusSession;
use serde_json::json;

/// The blocked URL from the hash, http(s) only: this page is web-accessible,
/// so any site can navigate here with a fragment of its choosing.
fn blocked_url() -> Option<url::Url> {
    let hash = window().location().hash().ok()?;
    let url = url::Url::parse(hash.strip_prefix('#')?).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

#[oxichrome::page(path = "src/pages/blocked/index.html", title = "Focus Mode", css = ["assets/theme.css", "assets/blocked.css"])]
pub fn Blocked() -> impl IntoView {
    super::use_theme();
    let (session, _) = use_storage::<Option<FocusSession>>("focusSession");
    let url = blocked_url();
    let host = url.as_ref().and_then(|u| {
        u.host_str()
            .map(|h| h.trim_start_matches("www.").to_string())
    });
    let (pomodoro, _) = use_storage::<Option<Pomodoro>>("pomodoro");
    let focusing = move || pomodoro.with(|p| is_focus(p.as_ref()));
    let reading = move || session.get().is_some_and(|s| !s.tab_ids.is_empty());
    let title = move || session.get().map(|s| s.title).unwrap_or_default();

    view! {
        <div id="root">
            {move || {
                let host = host.clone();
                if focusing() && !reading() {
                    let heading = match host {
                        Some(h) => format!("{h} is blocked until your break"),
                        None => "This site is blocked until your break".to_string(),
                    };
                    let tasks = pomodoro.get().map(|p| p.tasks).unwrap_or_default();
                    return view! {
                        <main class="blocked grid">
                            <div class="blocked-inner">
                                <h1>{heading}</h1>
                                <p class="blocked-intention">"This round you said you would:"</p>
                                <ul class="blocked-tasks">
                                    {tasks.into_iter().map(|t| view! { <li class:done=t.done>{t.text}</li> }).collect_view()}
                                </ul>
                            </div>
                        </main>
                    }
                    .into_any();
                }
                if !reading() {
                    let link = url.clone().map(|u| {
                        view! { <a class="blocked-continue" href=u.to_string()>"Continue to "{host.clone()}</a> }.into_any()
                    });
                    view! {
                        <main class="blocked grid">
                            <div class="blocked-inner">
                                <h1>"Reading session over"</h1>
                                {link.unwrap_or_else(|| view! { <p class="blocked-sub">"You're free to browse."</p> }.into_any())}
                            </div>
                        </main>
                    }
                    .into_any()
                } else {
                    let heading = match host {
                        Some(h) => format!("{h} is blocked while you read"),
                        None => "This site is blocked while you read".to_string(),
                    };
                    view! {
                        <main class="blocked grid">
                            <div class="blocked-inner">
                                <h1>{heading}</h1>
                                <Show when=move || !title().is_empty()>
                                    <p class="blocked-intention">"You're reading: "{title}</p>
                                </Show>
                                <button
                                    type="button"
                                    class="blocked-continue"
                                    autofocus
                                    on:click=|_| leptos::task::spawn_local(async { send(json!({ "type": "FOCUS_READER" })).await; })
                                >
                                    "Back to your paper"
                                </button>
                                <p class="blocked-sub">"Close the reader to end the session."</p>
                            </div>
                        </main>
                    }
                    .into_any()
                }
            }}
        </div>
    }
}

//! Settings (src/pages/options/Options.tsx, AlphaxivSection.tsx, SectionIndex.tsx).

use super::{patch_settings, send, use_settings, use_storage};
use leptos::prelude::*;
use reader_core::alphaxiv::{AlphaxivAuth, AlphaxivStatus};
use reader_core::focus_rules::normalize_block_domain;
use serde_json::json;
use wasm_bindgen::JsCast;

#[oxichrome::page(path = "src/pages/options/index.html", title = "Reader — Settings", css = ["assets/theme.css", "assets/options.css"])]
pub fn Options() -> impl IntoView {
    let (settings, loaded) = use_settings();
    let block_input = RwSignal::new(String::new());
    let block_feedback = RwSignal::new(None::<String>);

    let add_block_domain = move || {
        let Some(domain) = normalize_block_domain(&block_input.get_untracked()) else {
            block_feedback.set(Some("Not a valid domain (e.g. netflix.com).".into()));
            return;
        };
        let mut list = settings.get_untracked().focus_blocklist;
        if list.contains(&domain) {
            block_feedback.set(Some("Already on the list.".into()));
            return;
        }
        block_input.set(String::new());
        block_feedback.set(None);
        list.push(domain);
        leptos::task::spawn_local(
            async move { patch_settings("focusBlocklist", json!(list)).await },
        );
    };
    let remove_block_domain = move |domain: String| {
        let list: Vec<String> = settings
            .get_untracked()
            .focus_blocklist
            .into_iter()
            .filter(|d| *d != domain)
            .collect();
        leptos::task::spawn_local(
            async move { patch_settings("focusBlocklist", json!(list)).await },
        );
    };

    view! {
        <div id="root">
            <Show when=move || loaded.get()>
                <div class="colophon grid">
                    <header class="colophon-masthead">
                        <h1>"Settings"</h1>
                    </header>

                    <SectionIndex />

                    <main class="colophon-main">
                        <AlphaxivSection />

                        <section class="section" id="reader">
                            <h2>"Reader"</h2>
                            <div class="setting-row">
                                <label for="focus-line">
                                    "Focus line "
                                    <span class="hint-inline">"(dim everything but the passage you are reading; F toggles it)"</span>
                                </label>
                                <input
                                    id="focus-line"
                                    type="checkbox"
                                    prop:checked=move || settings.get().reader_focus_line
                                    on:change=move |e| {
                                        let on = event_target_checked(&e);
                                        leptos::task::spawn_local(async move { patch_settings("readerFocusLine", json!(on)).await });
                                    }
                                />
                            </div>
                        </section>

                        <section class="section" id="questions">
                            <h2>"Questions"</h2>
                            <p class="hint">
                                "alphaXiv finds the passages; Claude Haiku writes the questions, checks your explanations and defines terms. It never explains the paper to you."
                            </p>
                            <TextRow
                                id="claude-key"
                                label="Anthropic API key"
                                placeholder="sk-ant-…"
                                password=true
                                value=Signal::derive(move || settings.get().claude_key)
                                on_commit=Callback::new(|key: String| leptos::task::spawn_local(async move { patch_settings("claudeKey", json!(key)).await }))
                            />
                        </section>

                        <section class="section" id="reading-session">
                            <h2>"Reading session"</h2>
                            <p class="hint">"While a paper is open in the reader, these sites are blocked:"</p>
                            <form class="add-feed-form" on:submit=move |e| { e.prevent_default(); add_block_domain(); }>
                                <input
                                    type="text"
                                    aria-label="Domain to block"
                                    prop:value=move || block_input.get()
                                    on:input=move |e| block_input.set(event_target_value(&e))
                                    placeholder="Add a domain to block (e.g. netflix.com)"
                                />
                                <button type="submit">"Add"</button>
                            </form>
                            {move || block_feedback.get().map(|f| view! { <p class="feedback error" role="alert">{f}</p> })}
                            <ul class="feeds-list">
                                <For each=move || settings.get().focus_blocklist key=|d| d.clone() let:domain>
                                    {
                                        let label = format!("Unblock {domain}");
                                        let d = domain.clone();
                                        view! {
                                            <li class="feed-entry">
                                                <span class="feed-entry-url">{domain}</span>
                                                <button type="button" class="remove-feed-btn" aria-label=label on:click=move |_| remove_block_domain(d.clone())>
                                                    "✕"
                                                </button>
                                            </li>
                                        }
                                    }
                                </For>
                            </ul>
                        </section>
                    </main>
                </div>
            </Show>
        </div>
    }
}

/// A text setting saved on blur or Enter; Escape restores the saved value.
#[component]
fn TextRow(
    id: &'static str,
    label: &'static str,
    placeholder: &'static str,
    #[prop(optional)] password: bool,
    value: Signal<String>,
    on_commit: Callback<String>,
) -> impl IntoView {
    let draft = RwSignal::new(value.get_untracked());
    // The saved value wins if it changes underneath the field (another Settings tab).
    Effect::new(move |_| draft.set(value.get()));
    view! {
        <div class="setting-row">
            <label for=id>{label}</label>
            <input
                id=id
                type=if password { "password" } else { "text" }
                autocomplete="off"
                prop:value=move || draft.get()
                placeholder=placeholder
                on:input=move |e| draft.set(event_target_value(&e))
                on:blur=move |_| {
                    let d = draft.get_untracked().trim().to_string();
                    if d != value.get_untracked() {
                        on_commit.run(d);
                    }
                }
                on:keydown=move |e| {
                    if e.key() == "Enter" {
                        if let Some(el) = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlElement>().ok()) {
                            let _ = el.blur();
                        }
                    }
                    if e.key() == "Escape" {
                        draft.set(value.get_untracked());
                    }
                }
            />
        </div>
    }
}

/// Sign in to alphaXiv. The login happens in alphaXiv's own window.
#[component]
fn AlphaxivSection() -> impl IntoView {
    let (auth, loaded) = use_storage::<Option<AlphaxivAuth>>("alphaxivAuth");
    let (status, _) = use_storage::<AlphaxivStatus>("alphaxivStatus");
    let busy = RwSignal::new(None::<&'static str>);
    // "Synced 3m ago" stays true while the page sits open.
    let tick = RwSignal::new(0u32);
    set_interval(
        move || tick.update(|t| *t += 1),
        std::time::Duration::from_secs(30),
    );
    let run = move |kind: &'static str, msg: serde_json::Value| {
        busy.set(Some(kind));
        leptos::task::spawn_local(async move {
            send(msg).await;
            busy.set(None);
        });
    };
    let synced = move || {
        tick.get();
        match (busy.get(), status.get().last_sync_at) {
            (Some("syncing"), _) => "Syncing…".to_string(),
            (_, Some(at)) => format!(
                "Synced {}.",
                reader_core::format::relative_date(at, crate::js::now(), crate::js::local_date(at))
                    .to_lowercase()
            ),
            _ => "Not synced yet.".to_string(),
        }
    };

    view! {
        <section class="section" id="alphaxiv">
            <h2>"alphaXiv"</h2>
            // The heading renders before storage loads: the section index reads headings once, at mount.
            {move || {
                if !loaded.get() {
                    return ().into_any();
                }
                if auth.get().is_some() {
                    let email = status.get().email;
                    let who = if email.is_empty() { String::new() } else { format!(" as {email}") };
                    view! {
                        <p class="hint">"Signed in"{who}". Your alphaXiv folders are your shelves."</p>
                        <p class="hint" role="status" aria-live="polite">{synced}</p>
                        <div class="setting-row">
                            <button type="button" disabled=move || busy.get().is_some() on:click=move |_| run("syncing", json!({ "type": "ALPHAXIV_SYNC", "force": true }))>
                                "Sync now"
                            </button>
                            <button type="button" disabled=move || busy.get().is_some() on:click=|_| leptos::task::spawn_local(async { send(json!({ "type": "ALPHAXIV_SIGN_OUT" })).await; })>
                                "Sign out"
                            </button>
                        </div>
                    }
                    .into_any()
                } else {
                    view! {
                        <p class="hint">
                            "Sign in with your alphaXiv account. Your folders become your shelves here; progress and where you stopped stay in this browser."
                        </p>
                        <div class="setting-row">
                            <button type="button" disabled=move || busy.get().is_some() on:click=move |_| run("signing-in", json!({ "type": "ALPHAXIV_SIGN_IN" }))>
                                {move || if busy.get() == Some("signing-in") { "Waiting for alphaXiv…" } else { "Sign in to alphaXiv" }}
                            </button>
                        </div>
                    }
                    .into_any()
                }
            }}
            {move || {
                let error = status.get().error;
                (loaded.get() && !error.is_empty() && busy.get().is_none()).then(|| view! { <p class="feedback error" role="alert">{error}</p> })
            }}
        </section>
    }
}

/// The sticky table of contents; the section in view is lit.
#[component]
fn SectionIndex() -> impl IntoView {
    let sections = RwSignal::new(Vec::<(String, String)>::new());
    let active = RwSignal::new(String::new());
    let nav: NodeRef<leptos::html::Nav> = NodeRef::new();

    let update = move || {
        let doc = document();
        let Ok(nodes) = doc.query_selector_all("main section[id]") else {
            return;
        };
        let ids: Vec<web_sys::Element> = (0..nodes.length())
            .filter_map(|i| nodes.item(i)?.dyn_into().ok())
            .collect();
        // The section you are in is the last whose top has passed the upper third.
        let win = window();
        let height = win
            .inner_height()
            .ok()
            .and_then(|h| h.as_f64())
            .unwrap_or(0.0);
        let scroll = win.scroll_y().unwrap_or(0.0);
        let mut current = ids.first().map(|n| n.id()).unwrap_or_default();
        for node in &ids {
            if node.get_bounding_client_rect().top() <= height * 0.3 {
                current = node.id();
            }
        }
        let doc_height = doc
            .document_element()
            .map(|e| f64::from(e.scroll_height()))
            .unwrap_or(0.0);
        if scroll <= 0.0 {
            current = ids.first().map(|n| n.id()).unwrap_or_default();
        } else if scroll + height >= doc_height - 2.0 {
            current = ids.last().map(|n| n.id()).unwrap_or(current);
        }
        active.set(current);
    };

    Effect::new(move |_| {
        let doc = document();
        if let Ok(nodes) = doc.query_selector_all("main section[id]") {
            let found = (0..nodes.length())
                .filter_map(|i| nodes.item(i)?.dyn_into::<web_sys::Element>().ok())
                .map(|n| {
                    let title = n
                        .query_selector("h2")
                        .ok()
                        .flatten()
                        .and_then(|h| h.text_content())
                        .unwrap_or_else(|| n.id());
                    (n.id(), title)
                })
                .collect();
            sections.set(found);
        }
        update();
    });
    let handle = window_event_listener(leptos::ev::scroll, move |_| update());
    on_cleanup(move || handle.remove());

    // The bar under the lit link.
    Effect::new(move |_| {
        active.get();
        sections.get();
        let Some(nav) = nav.get() else { return };
        let Ok(Some(link)) = nav.query_selector("a[aria-current]") else {
            return;
        };
        let Ok(link) = link.dyn_into::<web_sys::HtmlElement>() else {
            return;
        };
        let style = nav.style();
        let _ = style.set_property("--indicator-y", &format!("{}px", link.offset_top()));
        let _ = style.set_property("--indicator-h", &format!("{}px", link.offset_height()));
    });

    view! {
        <nav node_ref=nav class="colophon-index" aria-label="Settings sections">
            <ol>
                <For each=move || sections.get() key=|(id, _)| id.clone() let:section>
                    {
                        let (id, title) = section;
                        let current = { let id = id.clone(); move || (active.get() == id).then_some("location") };
                        view! { <li><a href=format!("#{id}") aria-current=current>{title}</a></li> }
                    }
                </For>
            </ol>
        </nav>
    }
}

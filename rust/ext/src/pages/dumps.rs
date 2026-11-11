//! The only place past dumps can be read. The
//! private key lives in this page's memory alone: closing it locks it again.
//! While open it follows the stored list, so dumps sealed in another tab appear.

use super::use_storage;
use crate::js::{local_date, now};
use crate::{store, vault};
use leptos::prelude::*;
use reader_core::format::relative_date;
use reader_core::vault::{DumpEntry, LockedDump, Vault};
use std::collections::HashSet;
use wasm_bindgen::JsValue;

#[oxichrome::page(path = "src/pages/dumps/index.html", title = "Your dumps", css = ["assets/theme.css", "assets/dumps.css"])]
pub fn Dumps() -> impl IntoView {
    super::use_theme();
    let (stored, loaded) = use_storage::<Option<Vault>>("vault");
    let (locked, _) = use_storage::<Vec<LockedDump>>("lockedDumps");
    let key = RwSignal::new_local(None::<JsValue>);
    // None until the first opening is done; then the stored list is followed.
    let entries = RwSignal::new(None::<Vec<(String, DumpEntry)>>);
    // Ids that would not open, so they are not tried again.
    let broken = RwSignal::new(HashSet::<String>::new());
    let open = Memo::new(move |_| entries.with(Option::is_some));

    // Once unlocked, a dump sealed in another tab opens here too, and one
    // deleted anywhere goes.
    Effect::new(move |_| {
        let list = locked.get();
        let Some(k) = key.get() else { return };
        let ids: HashSet<&str> = list.iter().map(|d| d.id.as_str()).collect();
        entries.update(|e| {
            if let Some(e) = e {
                e.retain(|(id, _)| ids.contains(id.as_str()));
            }
        });
        broken.update(|b| b.retain(|id| ids.contains(id.as_str())));
        let known: HashSet<String> =
            entries.with_untracked(|e| e.iter().flatten().map(|(id, _)| id.clone()).collect());
        let fresh: Vec<LockedDump> = list
            .iter()
            .filter(|d| !known.contains(&d.id) && !broken.with_untracked(|b| b.contains(&d.id)))
            .cloned()
            .collect();
        if fresh.is_empty() {
            entries.update(|e| {
                e.get_or_insert_with(Vec::new);
            });
            return;
        }
        leptos::task::spawn_local(async move {
            let (opened, _) = vault::open_all(&k, &fresh).await;
            broken.try_update(|b| {
                b.extend(
                    fresh
                        .iter()
                        .filter(|d| !opened.iter().any(|(id, _)| *id == d.id))
                        .map(|d| d.id.clone()),
                )
            });
            entries.try_update(|e| {
                let e = e.get_or_insert_with(Vec::new);
                for (id, entry) in opened {
                    if !e.iter().any(|(i, _)| *i == id) {
                        e.push((id, entry));
                    }
                }
                e.sort_by_key(|(_, entry)| std::cmp::Reverse(entry.created_at));
            });
        });
    });

    view! {
        <div id="root">
            {move || {
                if !loaded.get() {
                    return ().into_any();
                }
                if stored.get().is_none() {
                    return view! {
                        <main class="dumps dumps-locked">
                            <h1 class="dumps-title">"Your dumps"</h1>
                            <p class="dumps-quiet">"Nothing locked yet."</p>
                        </main>
                    }
                    .into_any();
                }
                if !open.get() {
                    return view! { <Unlock on_open=Callback::new(move |k| key.set(Some(k))) /> }.into_any();
                }
                view! {
                    <main class="dumps">
                        <header class="dumps-head">
                            <h1 class="dumps-title">"Your dumps"</h1>
                            <span class="dumps-quiet">"Locks when you close this page"</span>
                        </header>
                        {move || {
                            let n = broken.with(HashSet::len);
                            (n > 0).then(|| view! {
                                <p class="dumps-quiet" role="status">
                                    {if n == 1 { "One entry couldn't be opened.".to_string() } else { format!("{n} entries couldn't be opened.") }}
                                </p>
                            })
                        }}
                        <For
                            each=move || entries.get().unwrap_or_default()
                            key=|(id, _)| id.clone()
                            children=move |(id, entry)| view! { <Entry id=id entry=entry /> }
                        />
                    </main>
                }
                .into_any()
            }}
        </div>
    }
}

/// Unlocks the vault; the private key goes to `on_open` and lives in this page's memory alone.
#[component]
fn Unlock(on_open: Callback<JsValue>) -> impl IntoView {
    let recovery = RwSignal::new(false);
    let secret = RwSignal::new(String::new());
    let error = RwSignal::new(String::new());
    let busy = RwSignal::new(false);

    let submit = move |e: leptos::ev::SubmitEvent| {
        e.prevent_default();
        let s = secret.get_untracked();
        if s.is_empty() || busy.get_untracked() {
            return;
        }
        busy.set(true);
        error.set(String::new());
        leptos::task::spawn_local(async move {
            let v: Option<Vault> = store::get("vault").await.ok().flatten();
            let Some(v) = v else {
                busy.set(false);
                return;
            };
            match vault::unlock_vault(&v, &s, recovery.get_untracked()).await {
                Ok(key) => on_open.run(key),
                Err(message) => {
                    error.set(message);
                    busy.set(false);
                }
            }
        });
    };
    let label = move || {
        if recovery.get() {
            "Recovery code"
        } else {
            "Passphrase"
        }
    };

    view! {
        <main class="dumps dumps-locked">
            <svg class="dumps-lock" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 11V8a4 4 0 0 1 8 0v3M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
            </svg>
            <h1 class="dumps-title">"Your dumps"</h1>
            <p class="dumps-quiet">"You chose to come here. Take your time."</p>
            <form on:submit=submit>
                <input
                    class="dumps-secret"
                    type=move || if recovery.get() { "text" } else { "password" }
                    aria-label=label
                    placeholder=label
                    autofocus
                    autocomplete="off"
                    prop:value=move || secret.get()
                    on:input=move |e| secret.set(event_target_value(&e))
                />
            </form>
            {move || (!error.get().is_empty()).then(|| view! { <p class="dumps-error" role="alert">{error.get()}</p> })}
            <button type="button" class="dumps-link" on:click=move |_| {
                recovery.update(|r| *r = !*r);
                secret.set(String::new());
                error.set(String::new());
            }>
                {move || if recovery.get() { "Use passphrase instead" } else { "Use recovery code instead" }}
            </button>
        </main>
    }
}

#[component]
fn Entry(id: String, entry: DumpEntry) -> impl IntoView {
    let show_raw = RwSignal::new(false);
    let confirming = RwSignal::new(false);
    let id = StoredValue::new(id);
    let remove = move |_| {
        // The page follows the stored list, so the entry goes once the write lands.
        leptos::task::spawn_local(async move {
            // A failed read must not become an empty list written back over every dump.
            let _ = vault::with_dump_lock(async move {
                let locked: Vec<LockedDump> = store::get("lockedDumps").await?;
                let next: Vec<LockedDump> = locked
                    .into_iter()
                    .filter(|d| d.id != id.get_value())
                    .collect();
                store::set("lockedDumps", &next).await
            })
            .await;
        });
    };
    let when = relative_date(entry.created_at, now(), local_date(entry.created_at));
    let text = entry.text.clone();
    let bullets = entry.bullets.clone();

    view! {
        <article class="dumps-entry">
            <div class="dumps-entry-head">
                <span>{when}</span>
                {move || if confirming.get() {
                    view! {
                        <span class="dumps-confirm">
                            "Delete for good?"
                            <button type="button" class="dumps-link is-danger" on:click=remove>"Delete"</button>
                            <button type="button" class="dumps-link" on:click=move |_| confirming.set(false)>"Keep"</button>
                        </span>
                    }
                    .into_any()
                } else {
                    view! { <button type="button" class="dumps-link is-quiet" on:click=move |_| confirming.set(true)>"Delete"</button> }.into_any()
                }}
            </div>
            {if bullets.is_empty() {
                view! { <p class="dumps-quiet">"No bullets for this one."</p> }.into_any()
            } else {
                view! { <ul class="dumps-bullets">{bullets.into_iter().map(|b| view! { <li>{b}</li> }).collect_view()}</ul> }.into_any()
            }}
            <button type="button" class="dumps-link" aria-expanded=move || if show_raw.get() { "true" } else { "false" } on:click=move |_| show_raw.update(|s| *s = !*s)>
                {move || if show_raw.get() { "Hide what I wrote" } else { "Show what I wrote" }}
            </button>
            {move || show_raw.get().then(|| view! { <p class="dumps-raw">{text.clone()}</p> })}
        </article>
    }
}

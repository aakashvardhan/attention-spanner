//! The new tab (src/pages/newtab/Dashboard.tsx, ActivityHeatmap.tsx,
//! BrainDump.tsx, VaultSetup.tsx, Icon.tsx).

use super::{send, use_settings, use_storage};
use crate::js::{local_date, now};
use crate::{chrome, claude, store, vault};
use leptos::prelude::*;
use reader_core::activity::{build_heat_model, heat_tooltip, plural, ActivityLog, Metric};
use reader_core::annotations::annotation_doc_key;
use reader_core::brain_dump::{
    parse_reframe, ASK_TIMEOUT_MS, FAILED_MESSAGE, MAX_DUMP_CHARS, NO_KEY_MESSAGE, REFRAME_SYSTEM,
};
use reader_core::constants::{CLAUDE_MODEL_QUICK, PAPERS_PAGE_PATH};
use reader_core::explain::ExplainBacks;
use reader_core::pdf::paper_open_url;
use reader_core::types::Paper;
use reader_core::vault::{Dump, DumpEntry, LockedDump, Vault};
use serde_json::json;
use std::cell::RefCell;

/// Papers listed under "Also on your desk".
const ALSO_READING_MAX: usize = 3;

#[oxichrome::page(path = "src/pages/newtab/index.html", title = "Focus workspace", css = ["assets/theme.css", "assets/newtab.css"])]
pub fn NewTab() -> impl IntoView {
    let (papers, _) = use_storage::<Vec<Paper>>("papers");
    // The shelf is alphaXiv's: refresh it (at most every two minutes) whenever this page opens.
    leptos::task::spawn_local(async {
        send(json!({ "type": "ALPHAXIV_SYNC" })).await;
    });
    let last_read = Memo::new(move |_| {
        papers
            .get()
            .into_iter()
            .filter(|p| p.last_read_at.is_some())
            .max_by_key(|p| p.last_read_at)
    });

    // The papers read before that one: what else is open on the desk.
    let also = Memo::new(move |_| {
        let mut read: Vec<Paper> = papers
            .get()
            .into_iter()
            .filter(|p| p.last_read_at.is_some() && p.progress_percent < 100.0)
            .collect();
        read.sort_by_key(|p| std::cmp::Reverse(p.last_read_at));
        let first = last_read.with(|l| l.as_ref().map(|p| p.id.clone()));
        read.into_iter()
            .filter(|p| Some(&p.id) != first.as_ref())
            .take(ALSO_READING_MAX)
            .collect::<Vec<_>>()
    });
    let (explains, _) = use_storage::<ExplainBacks>("explainBacks");
    let base = chrome::get_url("");

    view! {
        <div id="root">
            <main class="edition">
                <section class="read-section" aria-labelledby="continue-heading">
                    <h2 id="continue-heading" class="label">"Continue reading"</h2>
                    {move || match last_read.get() {
                        Some(p) => {
                            let href = paper_open_url(&p, false, &base);
                            let note = match (p.left_off.is_empty(), p.progress_percent.round() as i64) {
                                (true, n) => format!("{n}% read"),
                                (false, n) => format!("{} · {n}% read", p.left_off),
                            };
                            let key = annotation_doc_key(&p.url);
                            let gaps: Vec<(String, Option<u32>)> = explains.with(|e| {
                                e.get(&key).and_then(|l| l.last()).map(|x| x.gaps().map(|g| (format!("{}: {}", g.part.label(), g.gap), g.page)).collect()).unwrap_or_default()
                            });
                            view! {
                                <div class="continue">
                                    <a class="continue-paper" href=href.clone()>
                                        <span class="row-title">{p.title.clone()}</span>
                                        <span class="hint">{note}</span>
                                    </a>
                                    <div class="continue-gaps">
                                        {if gaps.is_empty() {
                                            view! { <p class="hint">"No open gaps. Press E in the reader to explain it back."</p> }.into_any()
                                        } else {
                                            view! {
                                                <h3 class="label">"Still open from your explain-back"</h3>
                                                <ul>
                                                    {gaps.into_iter().map(|(g, page)| {
                                                        let href = href.clone();
                                                        view! {
                                                            <li>
                                                                <span>{g}</span>
                                                                {page.map(|n| view! { <a class="gap-page" href=format!("{href}#page={n}")>{format!("Page {n}")}</a> })}
                                                            </li>
                                                        }
                                                    }).collect_view()}
                                                </ul>
                                            }.into_any()
                                        }}
                                    </div>
                                </div>
                            }
                            .into_any()
                        }
                        None => view! { <p class="hint">"Nothing open yet. Pick a paper from your shelf."</p> }.into_any(),
                    }}
                    <Show when=move || also.with(|a| !a.is_empty())>
                        <h3 class="label also-label">"Also on your desk"</h3>
                        <ul class="also">
                            {move || also.get().into_iter().map(|p| {
                                let n = p.progress_percent.round() as i64;
                                view! {
                                    <li>
                                        <a class="row" href=paper_open_url(&p, false, &chrome::get_url(""))>
                                            <span class="row-title">{p.title.clone()}</span>
                                            <span class="hint">{format!("{n}%")}</span>
                                        </a>
                                    </li>
                                }
                            }).collect_view()}
                        </ul>
                    </Show>
                </section>

                <div class="now-col">
                    <BrainDump />
                </div>
                <div class="heat-col">
                    <ActivityHeatmap papers=papers />
                </div>

                <footer class="edition-index">
                    <a class="edition-link" href=chrome::get_url(PAPERS_PAGE_PATH)>"Papers"</a>
                    <button type="button" class="edition-link" on:click=|_| { let _ = chrome::open_options_page(); }>
                        "Settings"
                    </button>
                </footer>
            </main>
        </div>
    }
}

#[component]
fn LockIcon(class: &'static str) -> impl IntoView {
    view! {
        <svg aria-hidden="true" class=class viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 11V8a4 4 0 0 1 8 0v3M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" />
        </svg>
    }
}

/* ---------- Activity ---------- */

#[component]
fn ActivityHeatmap(papers: ReadSignal<Vec<Paper>>) -> impl IntoView {
    let (log, _) = use_storage::<ActivityLog>("activity");
    let metric = RwSignal::new(Metric::All);
    let model = Memo::new(move |_| {
        let ids: Vec<(String, Option<i64>)> = papers
            .get()
            .into_iter()
            .map(|p| (p.id, p.last_read_at))
            .collect();
        build_heat_model(
            &log.get(),
            &ids,
            metric.get(),
            local_date(now()),
            local_date,
        )
    });
    let days = Memo::new(move |_| model.get().weeks.into_iter().flatten().collect::<Vec<_>>());
    // Future days only trail the last column, so today is the last past one.
    let today = Memo::new(move |_| {
        days.get()
            .iter()
            .filter(|d| d.level.is_some())
            .count()
            .saturating_sub(1)
    });
    let active = RwSignal::new(None::<usize>);
    let current = move || active.get().unwrap_or_else(|| today.get());
    let tip = RwSignal::new(None::<(String, f64, f64)>);
    let frame: NodeRef<leptos::html::Div> = NodeRef::new();

    let show = move |cell: web_sys::Element| {
        let Some(host) = frame.get() else { return };
        let (h, b) = (
            host.get_bounding_client_rect(),
            cell.get_bounding_client_rect(),
        );
        let i: usize = cell
            .get_attribute("data-i")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let text = days
            .with_untracked(|d| d.get(i).map(heat_tooltip))
            .unwrap_or_default();
        tip.set(Some((
            text,
            b.left() + b.width() / 2.0 - h.left(),
            b.top() - h.top(),
        )));
    };
    let on_key = move |e: leptos::ev::KeyboardEvent| {
        let step: i64 = match e.key().as_str() {
            "ArrowUp" => -1,
            "ArrowDown" => 1,
            "ArrowLeft" => -7,
            "ArrowRight" => 7,
            _ => return,
        };
        e.prevent_default();
        let next = (current() as i64 + step).clamp(0, today.get_untracked() as i64) as usize;
        active.set(Some(next));
        if let Some(el) = frame.get().and_then(|f| {
            f.query_selector(&format!("[data-i=\"{next}\"]"))
                .ok()
                .flatten()
        }) {
            use wasm_bindgen::JsCast;
            let _ = el.unchecked_into::<web_sys::HtmlElement>().focus();
        }
    };
    let headline = move || {
        let m = model.get();
        match metric.get() {
            Metric::Papers => format!("{} read in the last year", plural(m.papers, "paper")),
            Metric::Focus => format!(
                "{} finished in the last year",
                plural(m.focus, "focus session")
            ),
            Metric::All => format!(
                "{} and {} in the last year",
                plural(m.papers, "paper"),
                plural(m.focus, "focus session")
            ),
        }
    };

    view! {
        <section class="heat" aria-label="Activity">
            <h2 class="label">"Activity"</h2>
            <div class="heat-head">
                <p class="heat-title">{headline}</p>
                <div class="heat-seg" role="radiogroup" aria-label="Count">
                    {[(Metric::All, "Both"), (Metric::Papers, "Papers"), (Metric::Focus, "Focus")]
                        .into_iter()
                        .map(|(m, label)| view! {
                            <button type="button" role="radio" aria-checked=move || if metric.get() == m { "true" } else { "false" } on:click=move |_| metric.set(m)>
                                {label}
                            </button>
                        })
                        .collect_view()}
                </div>
            </div>

            <div class="heat-frame" node_ref=frame>
                <div class="heat-months" aria-hidden="true">
                    {move || model.get().months.into_iter().map(|(col, label)| view! { <span style=format!("grid-column-start: {}", col + 1)>{label}</span> }).collect_view()}
                </div>
                <div
                    class="heat-grid"
                    role="group"
                    aria-label="Daily papers and focus sessions, last 53 weeks"
                    on:keydown=on_key
                    on:mouseover=move |e| {
                        use wasm_bindgen::JsCast;
                        if let Some(cell) = e.target().and_then(|t| t.dyn_into::<web_sys::Element>().ok()).and_then(|t| t.closest("[data-i]").ok().flatten()) {
                            show(cell);
                        }
                    }
                    on:mouseleave=move |_| tip.set(None)
                    on:focusout=move |_| tip.set(None)
                >
                    {move || days.get().into_iter().enumerate().map(|(i, day)| match day.level {
                        None => view! { <span class="heat-cell heat-cell--future"></span> }.into_any(),
                        Some(level) => {
                            let label = heat_tooltip(&day);
                            view! {
                                <span
                                    class="heat-cell"
                                    data-i=i
                                    data-level=level
                                    role="img"
                                    aria-label=label
                                    tabindex=move || if i == current() { 0 } else { -1 }
                                    on:focus=move |e| {
                                        use wasm_bindgen::JsCast;
                                        active.set(Some(i));
                                        if let Some(el) = e.target().and_then(|t| t.dyn_into::<web_sys::Element>().ok()) { show(el); }
                                    }
                                ></span>
                            }
                            .into_any()
                        }
                    }).collect_view()}
                </div>
                {move || tip.get().map(|(text, x, y)| view! { <p class="heat-tip" aria-hidden="true" style=format!("--x: {x}px; --y: {y}px")>{text}</p> })}
            </div>
        </section>
    }
}

/* ---------- Brain dump ---------- */

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Writing,
    Streaming,
    Bullets,
    Setup,
    Failed,
}

thread_local! {
    /// The unsent draft and the id its words are saved under, kept across a remount, never stored.
    static DRAFT: RefCell<String> = const { RefCell::new(String::new()) };
    static SAVED_ID: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn saved_id() -> String {
    SAVED_ID.with(|s| {
        s.borrow_mut()
            .get_or_insert_with(chrome::random_uuid)
            .clone()
    })
}

/// Lock (or, before setup, park in the clear) under one id; a second save
/// replaces the first. Returns the vault it sealed with, read fresh.
async fn save(entry: DumpEntry, id: String) -> Option<Vault> {
    vault::with_dump_lock(async move {
        let stored: Option<Vault> = store::get("vault").await.ok().flatten();
        if let Some(v) = stored {
            let locked: Vec<LockedDump> = store::get("lockedDumps").await.unwrap_or_default();
            if let Ok(sealed) = vault::seal_entry(&v.public_key, &entry, id.clone()).await {
                let mut next = vec![sealed];
                next.extend(locked.into_iter().filter(|d| d.id != id));
                let _ = store::set("lockedDumps", &next).await;
            }
            return Some(v);
        }
        let dumps: Vec<Dump> = store::get("dumps").await.unwrap_or_default();
        let mut next = vec![Dump {
            id: id.clone(),
            text: entry.text.clone(),
            created_at: entry.created_at,
        }];
        next.extend(dumps.into_iter().filter(|d| d.id != id));
        let _ = store::set("dumps", &next).await;
        None
    })
    .await
}

/// Empty your head, Cmd+Enter, and Haiku hands it back a little lighter.
#[component]
fn BrainDump() -> impl IntoView {
    let (settings, _) = use_settings();
    let (stored_vault, _) = use_storage::<Option<Vault>>("vault");
    let (locked, _) = use_storage::<Vec<LockedDump>>("lockedDumps");
    let text = RwSignal::new(DRAFT.with(|d| d.borrow().clone()));
    let set_text = move |t: String| {
        DRAFT.with(|d| *d.borrow_mut() = t.clone());
        text.set(t);
    };
    let phase = RwSignal::new(Phase::Writing);
    let live = RwSignal::new(String::new());
    let bullets = RwSignal::new(Vec::<String>::new());
    let error = RwSignal::new(String::new());
    let current = RwSignal::new(None::<(DumpEntry, String)>);
    let input: NodeRef<leptos::html::Textarea> = NodeRef::new();

    // After a failed ask the cursor goes back so Cmd+Enter retries at once (not on load: J/K must reach the page).
    Effect::new(move |_| {
        if phase.get() == Phase::Failed {
            if let Some(box_) = input.get() {
                let _ = box_.focus();
                let len = box_.value().len() as u32;
                let _ = box_.set_selection_range(len, len);
            }
        }
    });

    let save_failed = move |words: String, created_at: i64| async move {
        save(
            DumpEntry {
                text: words,
                bullets: vec![],
                created_at,
            },
            saved_id(),
        )
        .await;
    };

    let submit = move || {
        let words = text.get_untracked().trim().to_string();
        let p = phase.get_untracked();
        if words.is_empty() || (p != Phase::Writing && p != Phase::Failed) {
            return;
        }
        let id = saved_id();
        let created_at = now();
        let key = settings.get_untracked().claude_key;
        leptos::task::spawn_local(async move {
            if key.is_empty() {
                save_failed(words, created_at).await;
                error.set(NO_KEY_MESSAGE.into());
                phase.set(Phase::Failed);
                return;
            }
            phase.set(Phase::Streaming);
            error.set(String::new());
            live.set(String::new());
            let ask = claude::Ask {
                api_key: &key,
                model: CLAUDE_MODEL_QUICK,
                system: REFRAME_SYSTEM,
                document: &words,
                prompt: "Give this back to me a little lighter.",
                cache: false,
                timeout_ms: ASK_TIMEOUT_MS as i32,
                controller: None,
            };
            let reply = claude::stream(ask, |t| live.set(t.to_string())).await;
            let parsed = reply.map(|r| parse_reframe(&r)).unwrap_or_default();
            if parsed.is_empty() {
                // The words are never lost: saved raw now, replaced if a retry works.
                save_failed(words, created_at).await;
                error.set(FAILED_MESSAGE.into());
                phase.set(Phase::Failed);
                return;
            }
            let entry = DumpEntry {
                text: words,
                bullets: parsed.clone(),
                created_at,
            };
            let sealed_with = save(entry.clone(), id.clone()).await;
            SAVED_ID.with(|s| s.borrow_mut().take());
            set_text(String::new());
            bullets.set(parsed);
            if sealed_with.is_some() {
                phase.set(Phase::Bullets);
            } else {
                current.set(Some((entry, id)));
                phase.set(Phase::Setup);
            }
        });
    };

    let shown = move || {
        if phase.get() == Phase::Streaming {
            parse_reframe(&live.get())
        } else {
            bullets.get()
        }
    };
    let writing = move || matches!(phase.get(), Phase::Writing | Phase::Failed);

    view! {
        <section class="notebook" aria-label="Brain dump">
            <p class="notebook-kicker">
                <LockIcon class="notebook-lock" />
                {move || if matches!(phase.get(), Phase::Bullets | Phase::Setup | Phase::Streaming) {
                    "A little lighter. Locking away when you leave."
                } else {
                    "Only Haiku reads this. Then it locks."
                }}
            </p>

            {move || if writing() {
                view! {
                    <textarea
                        node_ref=input
                        class="notebook-input"
                        aria-label="Empty your head here"
                        placeholder="Empty your head here"
                        maxlength=MAX_DUMP_CHARS
                        prop:value=move || text.get()
                        on:input=move |e| set_text(event_target_value(&e))
                        on:keydown=move |e| {
                            if e.key() == "Enter" && (e.meta_key() || e.ctrl_key()) {
                                e.prevent_default();
                                submit();
                            }
                        }
                    ></textarea>
                }
                .into_any()
            } else {
                view! {
                    <ul class="notebook-bullets" aria-live="polite">
                        {move || shown().into_iter().map(|line| view! { <li><span><Words text=line /></span></li> }).collect_view()}
                    </ul>
                }
                .into_any()
            }}

            {move || (phase.get() == Phase::Setup).then(|| current.get()).flatten().map(|cur| view! {
                <VaultSetup
                    current=cur
                    existing=stored_vault
                    on_done=Callback::new(move |used_existing: bool| {
                        current.set(None);
                        phase.set(Phase::Bullets);
                        if used_existing {
                            error.set("Locked with the passphrase you set in another tab.".into());
                        }
                    })
                />
            })}

            <div class="notebook-foot">
                {move || {
                    let e = error.get();
                    if !e.is_empty() {
                        Some(view! { <span class="notebook-note" role="alert">{e}</span> }.into_any())
                    } else {
                        let count = locked.get().len();
                        (count > 0 && stored_vault.get().is_some()).then(|| view! {
                            <a class="notebook-count" href=chrome::get_url("src/pages/dumps/index.html")>
                                <LockIcon class="notebook-lock" />
                                {count}" locked"
                            </a>
                        }.into_any())
                    }
                }}
                {move || writing().then(|| view! {
                    <span class="notebook-keys">
                        <kbd>"⌘"</kbd>
                        <kbd>"↵"</kbd>
                        {move || if phase.get() == Phase::Failed { "try again" } else { "when you are done" }}
                    </span>
                })}
            </div>
        </section>
    }
}

/// Text as words that each settle into focus; spaces stay inside the spans.
#[component]
fn Words(text: String) -> impl IntoView {
    let mut words = Vec::new();
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() {
            words.push(text[start..i + c.len_utf8()].to_string());
            start = i + c.len_utf8();
        }
    }
    if start < text.len() {
        words.push(text[start..].to_string());
    }
    words
        .into_iter()
        .map(|w| view! { <span class="dump-word">{w}</span> })
        .collect_view()
}

/// First-time setup, offered right after the first bullets. Nothing is stored
/// until "I wrote it down"; if another tab finishes first, its vault stands.
#[component]
fn VaultSetup(
    current: (DumpEntry, String),
    existing: ReadSignal<Option<Vault>>,
    on_done: Callback<bool>,
) -> impl IntoView {
    let pass = RwSignal::new(String::new());
    let confirm = RwSignal::new(String::new());
    let made = RwSignal::new(None::<(Vault, String)>);
    let busy = RwSignal::new(false);
    let committed = RwSignal::new(false);
    let current = StoredValue::new(current);

    let commit = move |fresh: Vault| {
        if committed.get_untracked() {
            return;
        }
        committed.set(true);
        leptos::task::spawn_local(async move {
            let used_existing = vault::with_dump_lock(async move {
                let stored: Option<Vault> = store::get("vault").await.ok().flatten();
                let dumps: Vec<Dump> = store::get("dumps").await.unwrap_or_default();
                let locked: Vec<LockedDump> = store::get("lockedDumps").await.unwrap_or_default();
                let had = stored.is_some();
                if let Ok((v, sealed)) =
                    vault::plan_setup(stored, &dumps, &locked, fresh, current.get_value()).await
                {
                    // Locked copies are written before the clear ones go.
                    let _ = store::set("vault", &v).await;
                    let _ = store::set("lockedDumps", &sealed).await;
                    let _ = store::set("dumps", &Vec::<Dump>::new()).await;
                }
                had
            })
            .await;
            on_done.run(used_existing);
        });
    };

    Effect::new(move |_| {
        if let Some(v) = existing.get() {
            if made.get_untracked().is_none() {
                commit(v);
            }
        }
    });

    let can_lock = move || !pass.get().is_empty() && pass.get() == confirm.get() && !busy.get();

    move || {
        match made.get() {
        Some((v, code)) => view! {
            <div class="notebook-setup">
                <p>"Write this down. It's the only way back in if you forget your passphrase."</p>
                <p class="notebook-code">{code}</p>
                <button type="button" class="edition-pill" disabled=move || busy.get() on:click=move |_| {
                    busy.set(true);
                    commit(v.clone());
                }>
                    "I wrote it down"
                </button>
            </div>
        }
        .into_any(),
        None => view! {
            <form class="notebook-setup" on:submit=move |e| {
                e.prevent_default();
                if !can_lock() {
                    return;
                }
                busy.set(true);
                let p = pass.get_untracked();
                leptos::task::spawn_local(async move {
                    if let Ok(result) = vault::create_vault(&p).await {
                        made.set(Some(result));
                    }
                    busy.set(false);
                });
            }>
                <p>"Set a passphrase so this can lock."</p>
                <input type="password" aria-label="Passphrase" placeholder="Passphrase" autocomplete="new-password" autofocus
                    prop:value=move || pass.get() on:input=move |e| pass.set(event_target_value(&e)) />
                <input type="password" aria-label="Passphrase again" placeholder="Passphrase again" autocomplete="new-password"
                    prop:value=move || confirm.get() on:input=move |e| confirm.set(event_target_value(&e)) />
                <button type="submit" class="edition-pill" disabled=move || !can_lock()>"Lock it"</button>
            </form>
        }
        .into_any(),
    }
    }
}

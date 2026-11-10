//! The new tab.

use super::{send, todo_drag, use_settings, use_storage};
use crate::js::{local_date, now};
use crate::voice::{self, Heard};
use crate::{chrome, claude, store, vault};
use leptos::prelude::*;
use reader_core::activity::{build_heat_model, heat_tooltip, plural, ActivityLog, Metric};
use reader_core::annotations::annotation_doc_key;
use reader_core::brain_dump::{
    dump_prompt, parse_dump, ASK_TIMEOUT_MS, DUMP_SYSTEM, FAILED_MESSAGE, MAX_DUMP_CHARS,
    NO_KEY_MESSAGE, SAVE_FAILED_MESSAGE,
};
use reader_core::constants::{CLAUDE_MODEL_QUICK, NOTES_PAGE_PATH, PAPERS_PAGE_PATH};
use reader_core::explain::ExplainBacks;
use reader_core::feed::{rss_items, FeedItem, HN_RSS};
use reader_core::pdf::paper_open_url;
use reader_core::pomodoro::{
    left_label, start_todos, sync_tasks, Phase as PomPhase, Pomodoro, MAX_TASKS,
};
use reader_core::todos::{
    format_local, keep_today, move_todo, parse_local, sky_label, sort_todos, todo_column,
    LocalTime, Todo,
};
use reader_core::types::{FocusSession, Paper};
use reader_core::vault::{Dump, DumpEntry, LockedDump, Vault};
use reader_core::voice::{
    char_to_utf16, clean_transcript, encode_wav, insert_transcript, trim_to_speech, utf16_to_char,
    SILENCE_STOP_MS,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use wasm_bindgen::{prelude::*, JsCast};
use wasm_bindgen_futures::JsFuture;

#[oxichrome::page(path = "src/pages/newtab/index.html", title = "New Tab", css = ["assets/theme.css", "assets/newtab.css"])]
pub fn NewTab() -> impl IntoView {
    super::use_theme();
    let (papers, papers_loaded) = use_storage::<Vec<Paper>>("papers");
    // The shelf is alphaXiv's: refresh it (at most every two minutes) whenever this page opens.
    leptos::task::spawn_local(async {
        send(json!({ "type": "ALPHAXIV_SYNC" })).await;
    });
    let (session, _) = use_storage::<Option<FocusSession>>("focusSession");
    let (explains, _) = use_storage::<ExplainBacks>("explainBacks");
    let (pomodoro, _) = use_storage::<Option<Pomodoro>>("pomodoro");
    // Read once here and handed down: each use_storage is its own listener.
    let (todos, todos_loaded) = use_storage::<Vec<Todo>>("todos");
    let (activity, _) = use_storage::<ActivityLog>("activity");
    let tick = RwSignal::new(now());
    set_interval(move || tick.set(now()), std::time::Duration::from_secs(1));
    // A running round counts down in the tab strip, where the other tabs are.
    let tab_title = Memo::new(move |_| {
        pomodoro.with(|p| match p {
            Some(p) => format!(
                "{} · {}",
                left_label(p.ends_at - tick.get()),
                if p.phase == PomPhase::Break {
                    "Break"
                } else {
                    "Focus"
                }
            ),
            None => "New Tab".to_string(),
        })
    });
    Effect::new(move |_| document().set_title(&tab_title.get()));
    // To read, in progress, completed: by how far each paper is read.
    let columns = Memo::new(move |_| {
        let mut cols: [Vec<Paper>; 3] = Default::default();
        for p in papers.get().into_iter().filter(|p| p.deleted_at.is_none()) {
            let i = if p.progress_percent >= 100.0 {
                2
            } else if p.last_read_at.is_some() || p.progress_percent > 0.0 {
                1
            } else {
                0
            };
            cols[i].push(p);
        }
        cols[0].sort_by_key(|p| std::cmp::Reverse(p.added_at));
        cols[1].sort_by_key(|p| std::cmp::Reverse(p.last_read_at));
        cols[2].sort_by_key(|p| std::cmp::Reverse(p.last_read_at));
        cols
    });
    let base = chrome::get_url("");
    // The one thing: the paper read last, a click from where it was left.
    let resume = Memo::new(move |_| columns.with(|c| c[1].first().cloned()));
    let resume_base = base.clone();
    let card = move |p: Paper, first: bool| {
        let href = paper_open_url(&p, false, &base);
        let n = p.progress_percent.round() as i64;
        let meta = match (p.left_off.is_empty(), n) {
            (_, 0) => p.authors.clone(),
            (true, n) => format!("{n}% read"),
            (false, n) => format!("{} · {n}% read", p.left_off),
        };
        let title = p.title.clone();
        let reading = move || session.with(|s| s.as_ref().is_some_and(|s| s.is_reading(&title)));
        let reading_dot = reading.clone();
        // The paper read last keeps its open gaps from the explain-back.
        let gaps: Vec<(String, Option<u32>)> = if first {
            let key = annotation_doc_key(&p.url);
            explains.with(|e| {
                e.get(&key)
                    .and_then(|l| l.last())
                    .map(|x| {
                        x.gaps()
                            .map(|g| (format!("{}: {}", g.part.label(), g.gap), g.page))
                            .collect()
                    })
                    .unwrap_or_default()
            })
        } else {
            vec![]
        };
        view! {
            <li class="paper-card" class:paper-card--reading=reading>
                <a class="paper-card-link" href=href.clone() title=p.title.clone()>
                    <span class="paper-card-title">
                        {move || reading_dot().then(|| view! { <span class="live-dot" role="img" aria-label="Reading now"></span> })}
                        {p.title.clone()}
                    </span>
                    {(!meta.is_empty()).then(|| view! { <span class="hint">{meta}</span> })}
                    {(n > 0 && n < 100).then(|| view! { <span class="paper-card-bar" style=format!("--p: {n}%")></span> })}
                </a>
                {(!gaps.is_empty()).then(|| view! {
                    <ul class="paper-card-gaps" aria-label="Still open from your explain-back">
                        {gaps.into_iter().map(|(g, page)| {
                            let href = href.clone();
                            view! {
                                <li>
                                    <span>{g}</span>
                                    {page.map(|n| view! { <a class="gap-page" href=format!("{href}#page={n}")>{format!("p. {n}")}</a> })}
                                </li>
                            }
                        }).collect_view()}
                    </ul>
                })}
            </li>
        }
    };

    view! {
        <div id="root">
            <main class="edition">
                <section class="focus-home" aria-label="Focus round">
                    <div class="today-lead">
                        <h1>"Today"</h1>
                        {move || match resume.get() {
                            None => view! { <p class="hint">"Pick one thing. Give it 25 minutes."</p> }.into_any(),
                            Some(p) => {
                                let n = p.progress_percent.round() as i64;
                                let meta = if p.left_off.is_empty() { format!("{n}% read") } else { format!("{} · {n}% read", p.left_off) };
                                view! {
                                    <a class="resume" href=paper_open_url(&p, false, &resume_base)>
                                        <span class="label">"Continue reading"</span>
                                        <span class="resume-title">{p.title.clone()}</span>
                                        <span class="hint">{meta}</span>
                                        <span class="fc-primary-btn resume-go">"Resume"</span>
                                    </a>
                                }.into_any()
                            }
                        }}
                    </div>
                    <Clock pomodoro=pomodoro tick=tick todos=todos log=activity />
                    <PomodoroPanel pomodoro=pomodoro tick=tick todos=todos />
                </section>
                <section class="board" aria-label="Reading board">
                    {[(1usize, "In progress"), (0, "To read"), (2, "Completed")].into_iter().map(|(i, name)| {
                        let heading = format!("board-{i}");
                        let labelled_by = heading.clone();
                        let card = card.clone();
                        view! {
                            <section class="board-col" aria-labelledby=labelled_by>
                                <details open={i == 1}>
                                <summary><h2 id=heading class="label board-head">
                                    {name}
                                    <span class="board-count">{move || columns.with(|c| c[i].len())}</span>
                                </h2></summary>
                                <ul class="board-list">
                                    {move || {
                                        let list = columns.with(|c| c[i].clone());
                                        // Not "nothing" until storage has answered: no flash of an empty shelf.
                                        if list.is_empty() && !papers_loaded.get() {
                                            return ().into_any();
                                        }
                                        if list.is_empty() {
                                            return view! { <li class="hint board-empty">"Nothing here yet."</li> }.into_any();
                                        }
                                        list.into_iter().enumerate().map(|(k, p)| card(p, i == 1 && k == 0)).collect_view().into_any()
                                    }}
                                </ul>
                                </details>
                            </section>
                        }
                    }).collect_view()}
                </section>

                <TodoBoard todos=todos loaded=todos_loaded pomodoro=pomodoro />

                <aside class="side-col">
                    <BrainDump />
                    <GameCard />
                    <ActivityHeatmap papers=papers log=activity />
                    <Show when=move || pomodoro.with(Option::is_none) && session.with(Option::is_none)>
                        <details class="news-disclosure"><summary>"News"</summary><HnFeed /></details>
                    </Show>
                </aside>

                <footer class="edition-index">
                    <a class="edition-link" href=chrome::get_url(PAPERS_PAGE_PATH)>"Papers"</a>
                    <a class="edition-link" href=chrome::get_url(NOTES_PAGE_PATH)>"Notes"</a>
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

/* ---------- The game ---------- */

/// Level, streak and today's quests (`reader_core::game`): derived, never stored.
#[component]
fn GameCard() -> impl IntoView {
    let (game, earned) = super::use_game();
    view! {
        <section class="game" aria-label="Progress" class:game--cleared=move || game.with(|g| g.cleared())>
            <h2 class="label">{move || if game.with(|g| g.cleared()) { "Progress · today cleared" } else { "Progress" }}</h2>
            <p class="game-head">
                <span class="game-level">{move || game.with(|g| format!("Level {}", g.level))}</span>
                <span class="hint" hidden=move || earned.with(Option::is_some)>{move || game.with(|g| format!("{} · {} of {} XP", g.title, g.into, g.span))}</span>
                // Always mounted, so a gain arriving later is announced.
                <span class="game-earned" role="status">{move || earned.get().unwrap_or_default()}</span>
                <span class="game-streak">{move || game.with(|g| match g.streak {
                    0 => "No streak yet".to_string(),
                    n => format!("{n}-day streak"),
                })}</span>
            </p>
            <span class="paper-card-bar" role="progressbar" aria-label="XP toward the next level" aria-valuemin="0"
                aria-valuemax=move || game.with(|g| g.span)
                aria-valuenow=move || game.with(|g| g.into)
                style=move || game.with(|g| format!("--p: {}%", g.into * 100 / g.span.max(1)))></span>
            <ul class="game-quests" aria-label="Today's quests">
                {move || game.with(|g| g.quests.clone()).into_iter().map(|q| view! {
                    <li class:game-quest--done=q.done><span>{q.label}</span><span class="hint">{q.detail}</span></li>
                }).collect_view()}
            </ul>
        </section>
    }
}

/* ---------- Activity ---------- */

#[component]
fn ActivityHeatmap(papers: ReadSignal<Vec<Paper>>, log: ReadSignal<ActivityLog>) -> impl IntoView {
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
                    {move || {
                        // Each label spans to the next month's column; CSS hides one that doesn't fit.
                        let months = model.get().months;
                        let ends: Vec<String> = months.iter().skip(1).map(|(c, _)| (c + 1).to_string()).chain(["-1".into()]).collect();
                        months.into_iter().zip(ends).map(|((col, label), end)| view! { <span style=format!("grid-column: {} / {}", col + 1, end)><b>{label}</b></span> }).collect_view()
                    }}
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

/// The mic button's state.
#[derive(Clone, Copy, PartialEq)]
enum Mic {
    Idle,
    Starting,
    Listening,
    Sending,
}

const NO_GROQ_KEY: &str = "Add a Groq key in Settings to talk your dump.";
const NO_SPEECH: &str = "Didn't catch any speech. Try again a little closer to the mic.";
const NO_WORDS: &str = "Couldn't make out any words. Try again?";
const CUT_SHORT: &str = "That ran past the box's limit, so the end was cut.";

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
async fn save(entry: DumpEntry, id: String) -> crate::js::Res<Option<Vault>> {
    vault::with_dump_lock(async move {
        let stored: Option<Vault> = store::get("vault").await?;
        if let Some(v) = stored {
            let locked: Vec<LockedDump> = store::get("lockedDumps").await?;
            let sealed = vault::seal_entry(&v.public_key, &entry, id.clone()).await?;
            let mut next = vec![sealed];
            next.extend(locked.into_iter().filter(|d| d.id != id));
            store::set("lockedDumps", &next).await?;
            return Ok(Some(v));
        }
        let dumps: Vec<Dump> = store::get("dumps").await?;
        let mut next = vec![Dump {
            id: id.clone(),
            text: entry.text.clone(),
            created_at: entry.created_at,
        }];
        next.extend(dumps.into_iter().filter(|d| d.id != id));
        store::set("dumps", &next).await?;
        Ok(None)
    })
    .await
}

/// Empty your head, Cmd+Enter, and Haiku hands it back a little lighter,
/// with the few tasks that matter most moved onto today's board.
#[component]
fn BrainDump() -> impl IntoView {
    let (settings, _) = use_settings();
    let (stored_vault, vault_loaded) = use_storage::<Option<Vault>>("vault");
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
    let mic = RwSignal::new(Mic::Idle);
    let hearing = RwSignal::new(false);
    let elapsed = RwSignal::new(0u32);
    let can_retry = RwSignal::new(false);
    // (id, text as added): Undo only removes tasks still exactly as they were added.
    let added_ids = RwSignal::new(Vec::<(String, String)>::new());
    let recorder = StoredValue::new_local(None::<voice::Recorder>);
    // The last clip Groq failed on, so Retry never asks you to say it again.
    let clip = StoredValue::new_local(None::<Vec<u8>>);

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
        .await
    };

    let submit = move || {
        let words = text.get_untracked().trim().to_string();
        let p = phase.get_untracked();
        if words.is_empty()
            || (p != Phase::Writing && p != Phase::Failed)
            || mic.get_untracked() != Mic::Idle
        {
            return;
        }
        let id = saved_id();
        let created_at = now();
        let key = settings.get_untracked().claude_key;
        leptos::task::spawn_local(async move {
            if key.is_empty() {
                let saved = save_failed(words, created_at).await.is_ok();
                error.set(if saved {
                    NO_KEY_MESSAGE.into()
                } else {
                    SAVE_FAILED_MESSAGE.into()
                });
                phase.set(Phase::Failed);
                return;
            }
            phase.set(Phase::Streaming);
            error.set(String::new());
            live.set(String::new());
            added_ids.set(Vec::new());
            let prompt = dump_prompt(&now_label());
            let ask = claude::Ask {
                api_key: &key,
                model: CLAUDE_MODEL_QUICK,
                system: DUMP_SYSTEM,
                document: &words,
                prompt: &prompt,
                cache: false,
                timeout_ms: ASK_TIMEOUT_MS as i32,
                controller: None,
                image_jpeg: None,
                remember: false,
            };
            let reply = claude::stream(ask, |t| live.set(t.to_string())).await;
            let (parsed, tasks) = reply.map(|r| parse_dump(&r)).unwrap_or_default();
            // No bullets is a failure even if tasks came back: the board only
            // changes on success, so a retry never adds the same tasks twice.
            if parsed.is_empty() {
                // The words are never lost: saved raw now, replaced if a retry works.
                let saved = save_failed(words, created_at).await.is_ok();
                error.set(if saved {
                    FAILED_MESSAGE.into()
                } else {
                    SAVE_FAILED_MESSAGE.into()
                });
                phase.set(Phase::Failed);
                return;
            }
            let entry = DumpEntry {
                text: words,
                bullets: parsed.clone(),
                created_at,
            };
            let sealed_with = match save(entry.clone(), id.clone()).await {
                Ok(v) => v,
                Err(_) => {
                    error.set(SAVE_FAILED_MESSAGE.into());
                    phase.set(Phase::Failed);
                    return;
                }
            };
            SAVED_ID.with(|s| s.borrow_mut().take());
            if !tasks.is_empty() {
                let texts: Vec<String> = tasks.iter().map(|(t, _)| t.clone()).collect();
                match add_tasks(tasks).await {
                    Ok(ids) => added_ids.set(ids.into_iter().zip(texts).collect()),
                    Err(_) => error.set("Your words were saved, but the tasks couldn't be added. Add them to the board yourself.".into()),
                }
            }
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

    // Voice: talk instead of typing. The words land in the box at the cursor;
    // you read them over and press Cmd+Enter as ever.
    let send_clip = move |wav: Vec<u8>| {
        let key = settings.get_untracked().groq_key;
        mic.set(Mic::Sending);
        error.set(String::new());
        can_retry.set(false);
        leptos::task::spawn_local(async move {
            let heard = voice::transcribe(&key, &wav).await;
            mic.set(Mic::Idle);
            let words = match heard {
                Ok(raw) => clean_transcript(&raw),
                Err(m) => {
                    clip.set_value(Some(wav));
                    can_retry.set(true);
                    error.set(m);
                    return;
                }
            };
            if words.is_empty() {
                error.set(NO_WORDS.into());
                return;
            }
            let draft = text.get_untracked();
            let at = input
                .get_untracked()
                .and_then(|b| b.selection_start().ok().flatten())
                .map_or(usize::MAX, |u| utf16_to_char(&draft, u as usize));
            let (next, cursor, cut) = insert_transcript(&draft, at, &words, MAX_DUMP_CHARS);
            let caret = char_to_utf16(&next, cursor) as u32;
            set_text(next);
            if cut {
                error.set(CUT_SHORT.into());
            }
            // After the box has the new value, or the caret jumps back.
            request_animation_frame(move || {
                if let Some(b) = input.get_untracked() {
                    let _ = b.focus();
                    let _ = b.set_selection_range(caret, caret);
                }
            });
        });
    };

    let take_recorder = move || {
        let mut taken = None;
        recorder.update_value(|r| taken = r.take());
        hearing.set(false);
        taken
    };

    // Stop, keep only the speech, send it. Nothing is sent if nothing was said.
    let finish = move || {
        let Some(rec) = take_recorder() else { return };
        let speech = trim_to_speech(&rec.finish());
        if speech.is_empty() {
            mic.set(Mic::Idle);
            error.set(NO_SPEECH.into());
            return;
        }
        send_clip(encode_wav(&speech));
    };

    let cancel = move || {
        drop(take_recorder());
        if matches!(mic.get_untracked(), Mic::Listening | Mic::Starting) {
            mic.set(Mic::Idle);
        }
    };

    let toggle_mic = move || match mic.get_untracked() {
        Mic::Listening => finish(),
        Mic::Starting | Mic::Sending => {}
        Mic::Idle => {
            if settings.get_untracked().groq_key.is_empty() {
                error.set(NO_GROQ_KEY.into());
                return;
            }
            mic.set(Mic::Starting);
            error.set(String::new());
            can_retry.set(false);
            elapsed.set(0);
            leptos::task::spawn_local(async move {
                let started = voice::start(SILENCE_STOP_MS, move |h| match h {
                    Heard::Frame { ms, speaking } => {
                        if hearing.get_untracked() != speaking {
                            hearing.set(speaking);
                        }
                        if elapsed.get_untracked() != ms / 1000 {
                            elapsed.set(ms / 1000);
                        }
                    }
                    // Not from inside the recorder's own callback: finishing drops it.
                    Heard::Done => leptos::task::spawn_local(async move { finish() }),
                })
                .await;
                match started {
                    // Cancelled while the permission prompt was up: dropping it stops the mic.
                    Ok(rec) if mic.get_untracked() == Mic::Starting => {
                        recorder.set_value(Some(rec));
                        mic.set(Mic::Listening);
                    }
                    Ok(_) => {}
                    Err(m) => {
                        mic.set(Mic::Idle);
                        error.set(m);
                    }
                }
            });
        }
    };

    let retry = move || {
        let mut wav = None;
        clip.update_value(|c| wav = c.take());
        if let Some(wav) = wav {
            send_clip(wav);
        }
    };

    // Leaving the tab mid-sentence sends what was said; closing it lets the mic go.
    let on_hidden = window_event_listener_untyped("visibilitychange", move |_| {
        if document().hidden() && mic.get_untracked() == Mic::Listening {
            finish();
        }
    });
    // On the window: the button is disabled while the mic starts, which drops focus to <body>.
    let on_esc = window_event_listener(leptos::ev::keydown, move |e| {
        if e.key() == "Escape" && matches!(mic.get_untracked(), Mic::Listening | Mic::Starting) {
            e.prevent_default();
            cancel();
        }
    });
    on_cleanup(move || {
        drop(take_recorder());
        on_hidden.remove();
        on_esc.remove();
    });

    let mic_status = move || {
        let t = elapsed.get();
        let clock = format!("{}:{:02}", t / 60, t % 60);
        match mic.get() {
            Mic::Listening if hearing.get() => format!("Hearing you · {clock}"),
            Mic::Listening => format!("Listening, stops when you pause · {clock}"),
            Mic::Sending => "Writing it down…".to_string(),
            _ => String::new(),
        }
    };

    let shown = move || {
        if phase.get() == Phase::Streaming {
            parse_dump(&live.get()).0
        } else {
            bullets.get()
        }
    };
    let writing = move || matches!(phase.get(), Phase::Writing | Phase::Failed);

    view! {
        <section class="notebook" aria-label="Brain dump">
            <p class="notebook-kicker">
                <LockIcon class="notebook-lock" />
                {move || if !vault_loaded.get() {
                    "Checking vault…"
                } else if stored_vault.with(Option::is_none) {
                    "Vault setup needed. Submitted words stay unencrypted until you set a passphrase."
                } else {
                    "Sent to Claude when you submit. Saved encrypted on this device."
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
                <Show when=move || added_ids.with(|ids| !ids.is_empty())>
                    <span class="notebook-note" role="status">{move || format!("Added {} to your board. Undo leaves any you have edited or started.", plural(added_ids.with(Vec::len) as u32, "task"))}</span>
                    <button type="button" class="edition-pill" on:click=move |_| {
                        let ids = added_ids.get_untracked();
                        leptos::task::spawn_local(async move {
                            let untouched = move |t: &Todo| ids.iter().any(|(id, text)| *id == t.id && *text == t.text) && t.started_at.is_none() && t.done_at.is_none();
                            if update_todos(move |list| list.retain(|t| !untouched(t))).await.is_ok() {
                                added_ids.try_set(Vec::new());
                            } else { error.try_set("Couldn't undo the added tasks. Try again.".into()); }
                        });
                    }>"Undo added tasks"</button>
                </Show>
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
                    <button type="button" class="fc-primary-btn" disabled=move || text.with(|t| t.trim().is_empty()) || mic.get() != Mic::Idle on:click=move |_| submit()>
                        {move || if phase.get() == Phase::Failed { "Try again" } else { "Make it lighter" }}
                    </button>
                    <span class="notebook-mic-status" aria-live="polite">
                        {move || (mic.get() == Mic::Listening).then(|| view! {
                            <span class="notebook-mic-dot" class:notebook-mic-dot--on=move || hearing.get() aria-hidden="true"></span>
                        })}
                        {mic_status}
                    </span>
                    {move || (can_retry.get() && mic.get() == Mic::Idle).then(|| view! {
                        <button type="button" class="edition-pill notebook-mic" on:click=move |_| retry()>"Retry"</button>
                    })}
                    <button
                        type="button"
                        class="edition-pill notebook-mic"
                        class:notebook-mic--on=move || mic.get() == Mic::Listening
                        disabled=move || matches!(mic.get(), Mic::Starting | Mic::Sending)
                        title=move || (mic.get() == Mic::Listening).then_some("Stop and write it down (Esc to discard)")
                        on:click=move |_| toggle_mic()
                    >
                        {move || match mic.get() {
                            Mic::Idle => "Talk",
                            Mic::Starting => "Starting…",
                            Mic::Listening => "Stop",
                            Mic::Sending => "Writing…",
                        }}
                    </button>
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
    let setup_error = RwSignal::new(String::new());
    let current = StoredValue::new(current);

    let commit = move |fresh: Vault| {
        if committed.get_untracked() {
            return;
        }
        committed.set(true);
        setup_error.set(String::new());
        let entry = current.get_value();
        leptos::task::spawn_local(async move {
            let result: crate::js::Res<bool> = vault::with_dump_lock(async move {
                let stored: Option<Vault> = store::get("vault").await?;
                let dumps: Vec<Dump> = store::get("dumps").await?;
                let locked: Vec<LockedDump> = store::get("lockedDumps").await?;
                let had = stored.is_some();
                let (v, sealed) = vault::plan_setup(stored, &dumps, &locked, fresh, entry).await?;
                let items = json!({ "vault": v, "lockedDumps": sealed, "dumps": [] });
                store::set_many(items.as_object().expect("object")).await?;
                Ok(had)
            })
            .await;
            match result {
                Ok(used_existing) => on_done.run(used_existing),
                Err(_) => {
                    committed.try_set(false);
                    busy.try_set(false);
                    setup_error.try_set(
                        "Couldn't lock your words. They are still unencrypted. Try again.".into(),
                    );
                }
            }
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
                <Show when=move || setup_error.with(|e| !e.is_empty())><p role="alert">{move || setup_error.get()}</p></Show>
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
                    match vault::create_vault(&p).await {
                        Ok(result) => made.set(Some(result)),
                        Err(_) => setup_error.set("Couldn't create the vault. Try again.".into()),
                    }
                    busy.set(false);
                });
            }>
                <Show when=move || setup_error.with(|e| !e.is_empty())><p role="alert">{move || setup_error.get()}</p></Show>
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

/* ---------- Today ---------- */

/// A local wall-clock time as epoch ms.
fn to_ms((y, mo, d, h, mi): LocalTime) -> i64 {
    js_sys::Date::new_with_year_month_day_hr_min(
        y as u32,
        mo as i32 - 1,
        d as i32,
        h as i32,
        mi as i32,
    )
    .get_time() as i64
}

fn local_parts(ms: i64) -> LocalTime {
    let d = js_sys::Date::new(&JsValue::from_f64(ms as f64));
    (
        d.get_full_year() as i32,
        d.get_month() + 1,
        d.get_date(),
        d.get_hours(),
        d.get_minutes(),
    )
}

fn today_start() -> i64 {
    let (y, mo, d, _, _) = local_parts(now());
    to_ms((y, mo, d, 0, 0))
}

/// "Monday 2026-11-02 14:05", so Haiku can resolve "tomorrow" and "Friday".
fn now_label() -> String {
    const DAYS: [&str; 7] = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ];
    let day = DAYS[js_sys::Date::new_0().get_day() as usize % 7];
    format!(
        "{day} {}",
        format_local(local_parts(now())).replace('T', " ")
    )
}

/// The dump's top tasks, after today's open ones, in Haiku's priority order.
async fn add_tasks(tasks: Vec<(String, Option<LocalTime>)>) -> crate::js::Res<Vec<String>> {
    let ids: Vec<String> = tasks.iter().map(|_| chrome::random_uuid()).collect();
    let kept_ids = ids.clone();
    update_todos(move |list| {
        let base = list
            .iter()
            .filter(|t| todo_column(t) == 0)
            .map(|t| t.rank + 1)
            .max()
            .unwrap_or(0);
        list.extend(
            tasks
                .into_iter()
                .zip(ids)
                .enumerate()
                .map(|(i, ((text, when), id))| Todo {
                    id,
                    text,
                    due_at: when.map(to_ms),
                    rank: base + i as i32,
                    ..Default::default()
                }),
        );
    })
    .await?;
    Ok(kept_ids)
}

async fn change_tasks(
    f: impl FnOnce(&mut Vec<Todo>, &mut Option<Pomodoro>) -> crate::js::Res<()> + 'static,
) -> crate::js::Res<()> {
    store::with_lock("tasks", async move {
        let mut list: Vec<Todo> = store::get("todos").await?;
        let mut round: Option<Pomodoro> = store::get("pomodoro").await?;
        f(&mut list, &mut round)?;
        if let Some(p) = round.as_mut() {
            sync_tasks(p, &list);
        }
        let items = json!({"todos": keep_today(list, today_start()), "pomodoro": round});
        store::set_many(items.as_object().expect("object")).await
    })
    .await
}

/// Board and focus checkboxes share one transaction, including edits and deletion.
async fn update_todos(f: impl FnOnce(&mut Vec<Todo>) + 'static) -> crate::js::Res<()> {
    change_tasks(move |list, _| {
        f(list);
        Ok(())
    })
    .await
}

async fn begin_round(ids: Vec<String>, video: String) -> crate::js::Res<()> {
    let study_video = if video.trim().is_empty() {
        None
    } else {
        Some(
            reader_core::youtube::video_id(video.trim())
                .ok_or_else(|| crate::js::error("Enter a valid YouTube video link."))?,
        )
    };
    change_tasks(move |list, round| {
        if round.is_some() {
            return Err(crate::js::error(
                "A round is already running. Stop it before starting another.",
            ));
        }
        let mut p = start_todos(list, &ids, now())
            .ok_or_else(|| crate::js::error("Choose an unfinished task."))?;
        p.study_video = study_video;
        *round = Some(p);
        Ok(())
    })
    .await
}

/// Today's to-dos (from brain dumps, or typed here) as a board: To do, In
/// progress, Done. Each card retimes its reminder, moves, or is deleted.
#[component]
fn TodoBoard(
    todos: ReadSignal<Vec<Todo>>,
    loaded: ReadSignal<bool>,
    pomodoro: ReadSignal<Option<Pomodoro>>,
) -> impl IntoView {
    let feedback = RwSignal::new(String::new());
    // A drop shows at once; storage catches up a moment later and takes over.
    let dropped = RwSignal::new(None::<Vec<Todo>>);
    Effect::new(move |_| {
        todos.track();
        dropped.set(None);
    });
    let columns = Memo::new(move |_| {
        let mut list = keep_today(dropped.get().unwrap_or_else(|| todos.get()), today_start());
        sort_todos(&mut list);
        let mut cols: [Vec<Todo>; 3] = Default::default();
        for t in list {
            cols[todo_column(&t)].push(t);
        }
        cols
    });
    let edit = move |id: String, f: Box<dyn FnOnce(&mut Todo)>| {
        leptos::task::spawn_local(async move {
            if update_todos(move |list| {
                if let Some(t) = list.iter_mut().find(|t| t.id == id) {
                    f(t);
                }
            })
            .await
            .is_err()
            {
                feedback.try_set("Couldn't save the task. Try again.".into());
            }
        });
    };
    let draft = RwSignal::new(String::new());
    let add = move || {
        let text = draft.get_untracked().trim().to_string();
        if text.is_empty() {
            return;
        }
        draft.set(String::new());
        leptos::task::spawn_local(async move {
            if update_todos(move |list| {
                list.push(Todo {
                    id: chrome::random_uuid(),
                    text,
                    ..Default::default()
                })
            })
            .await
            .is_err()
            {
                feedback.try_set("Couldn't add the task. Try again.".into());
            }
        });
    };
    let on_drop = move |id: String, col: usize, idx: usize| {
        let t = now();
        let mut list = keep_today(
            dropped
                .get_untracked()
                .unwrap_or_else(|| todos.get_untracked()),
            today_start(),
        );
        move_todo(&mut list, &id, col, idx, t);
        dropped.set(Some(list));
        leptos::task::spawn_local(async move {
            if update_todos(move |l| move_todo(l, &id, col, idx, t))
                .await
                .is_err()
            {
                feedback.try_set("Couldn't move the task. Try again.".into());
            }
        });
    };
    let card = move |t: Todo, col: usize| {
        let (id1, id2, id3, id4, id5, id6) = (
            t.id.clone(),
            t.id.clone(),
            t.id.clone(),
            t.id.clone(),
            t.id.clone(),
            t.id.clone(),
        );
        let done = col == 2;
        let original_text = t.text.clone();
        let late = !done && t.due_at.is_some_and(|d| d < now());
        let when = t
            .due_at
            .map(|d| format_local(local_parts(d)))
            .unwrap_or_default();
        let timed = !when.is_empty();
        // One step forward, one step back: To do -> In progress -> Done.
        let (fwd, back) = match col {
            0 => (Some("Start"), None),
            1 => (Some("Done"), Some("Back")),
            _ => (None, Some("Reopen")),
        };
        view! {
            <li class="todo" class:todo--done=done class:todo--late=late data-todo-id=t.id.clone()
                on:pointerdown=move |e| todo_drag::down(&e, id5.clone(), col, std::rc::Rc::new(on_drop))>
                <input class="todo-text todo-text-input" type="text" maxlength="120" aria-label=format!("Edit task: {}", t.text) prop:value=t.text.clone() on:change=move |e| {
                    let text = event_target_value(&e).trim().to_string();
                    if text.is_empty() {
                        if let Some(input) = e.target().and_then(|t| t.dyn_into::<web_sys::HtmlInputElement>().ok()) { input.set_value(&original_text); }
                    } else { edit(id6.clone(), Box::new(move |t| t.text = text)); }
                } />
                <div class="todo-row">
                    <input type="datetime-local" class="todo-when" class:todo-when--set=timed aria-label=format!("Remind me: {}", t.text) prop:value=when on:change=move |e| {
                        let due = parse_local(&event_target_value(&e)).map(to_ms);
                        edit(id1.clone(), Box::new(move |t| t.due_at = due));
                    } />
                    {back.map(|label| view! {
                        <button type="button" class="todo-move" on:click=move |_| edit(id2.clone(), Box::new(move |t| {
                            if t.done_at.is_some() { t.done_at = None } else { t.started_at = None }
                        }))>{label}</button>
                    })}
                    {fwd.map(|label| view! {
                        // To do: "Focus" starts a round on this task (it blocks
                        // distracting sites); during a round it is "Start" and
                        // only moves the task to In progress.
                        <button type="button" class="todo-move todo-move--fwd" on:click=move |_| {
                            let running = pomodoro.with_untracked(Option::is_some);
                            if col == 0 && running {
                                edit(id3.clone(), Box::new(move |t| t.started_at = Some(now())));
                            } else if col == 0 {
                                let id = id3.clone();
                                leptos::task::spawn_local(async move {
                                    if let Err(e) = begin_round(vec![id], String::new()).await {
                                        feedback.try_set(js_sys::Error::from(e).message().into());
                                    }
                                });
                            } else { edit(id3.clone(), Box::new(move |t| t.done_at = Some(now()))); }
                        }>{move || if col == 0 && pomodoro.with(Option::is_none) { "Focus" } else { label }}</button>
                    })}
                    <button type="button" class="todo-delete" aria-label=format!("Delete {}", t.text) on:click=move |_| {
                        let id = id4.clone();
                        leptos::task::spawn_local(async move {
                            if update_todos(move |l| l.retain(|t| t.id != id)).await.is_err() { feedback.try_set("Couldn't delete the task. Try again.".into()); }
                        });
                    }>"×"</button>
                </div>
            </li>
        }
    };

    view! {
        <section class="board board--todos" aria-label="Today's to-dos">
            <Show when=move || feedback.with(|s| !s.is_empty())><p role="alert">{move || feedback.get()}</p></Show>
            {[(0usize, "To do"), (1, "In progress"), (2, "Done")].into_iter().map(|(i, name)| {
                let heading = format!("todo-col-{i}");
                let labelled_by = heading.clone();
                view! {
                    <section class="board-col" aria-labelledby=labelled_by>
                        <details open={i != 2}>
                        <summary><h2 id=heading class="label board-head">
                            {name}
                            <span class="board-count">{move || columns.with(|c| c[i].len())}</span>
                        </h2></summary>
                        <ul class="board-list">
                            {move || {
                                let list = columns.with(|c| c[i].clone());
                                if list.is_empty() && i != 0 {
                                    if !loaded.get() {
                                        return ().into_any();
                                    }
                                    return view! { <li class="hint board-empty">"Nothing here yet."</li> }.into_any();
                                }
                                list.into_iter().map(|t| card(t, i)).collect_view().into_any()
                            }}
                            {(i == 0).then(|| view! {
                                <li>
                                    <form class="todo-add" on:submit=move |e| { e.prevent_default(); add(); }>
                                        <input type="text" maxlength="120" placeholder="Add a to-do" aria-label="Add a to-do"
                                            prop:value=move || draft.get() on:input=move |e| draft.set(event_target_value(&e)) />
                                    </form>
                                </li>
                            })}
                        </ul>
                        </details>
                    </section>
                }
            }).collect_view()}
        </section>
    }
}

/* ---------- Clock ---------- */

#[derive(Clone, Serialize, Deserialize)]
struct SkyNow {
    at: i64,
    temp: f64,
    code: i64,
    unit: String,
}

const SKY_FRESH_MS: i64 = 30 * 60 * 1000;

/// Where the browser thinks we are (an hour-old fix is fine for weather).
async fn position() -> Option<(f64, f64)> {
    let geo = web_sys::window()?.navigator().geolocation().ok()?;
    let promise = js_sys::Promise::new(&mut |resolve, reject| {
        let ok = Closure::once_into_js(move |p: JsValue| {
            let _ = resolve.call1(&JsValue::NULL, &p);
        });
        let err = Closure::once_into_js(move |e: JsValue| {
            let _ = reject.call1(&JsValue::NULL, &e);
        });
        let opts = web_sys::PositionOptions::new();
        opts.set_maximum_age(3_600_000);
        opts.set_timeout(10_000);
        let _ = geo.get_current_position_with_error_callback_and_options(
            ok.unchecked_ref(),
            Some(err.unchecked_ref()),
            &opts,
        );
    });
    let pos = JsFuture::from(promise).await.ok()?;
    let coords = js_sys::Reflect::get(&pos, &"coords".into()).ok()?;
    let get = |k: &str| js_sys::Reflect::get(&coords, &k.into()).ok()?.as_f64();
    Some((get("latitude")?, get("longitude")?))
}

/// The current temperature from Open-Meteo (no key), cached for half an hour.
async fn sky_now() -> Option<SkyNow> {
    if let Ok(Some(c)) = store::get::<Option<SkyNow>>("weatherNow").await {
        if now() - c.at < SKY_FRESH_MS {
            return Some(c);
        }
    }
    let (lat, lon) = position().await?;
    let us = web_sys::window()?
        .navigator()
        .language()
        .is_some_and(|l| l == "en-US");
    let unit = if us { "fahrenheit" } else { "celsius" };
    let url = format!("https://api.open-meteo.com/v1/forecast?latitude={lat:.2}&longitude={lon:.2}&current=temperature_2m,weather_code&temperature_unit={unit}");
    let res: web_sys::Response = JsFuture::from(chrome::fetch(&url, &JsValue::UNDEFINED).ok()?)
        .await
        .ok()?
        .unchecked_into();
    let body: Value = crate::js::from_js(JsFuture::from(res.json().ok()?).await.ok()?).ok()?;
    let sky = SkyNow {
        at: now(),
        temp: body["current"]["temperature_2m"].as_f64()?,
        code: body["current"]["weather_code"].as_i64().unwrap_or(-1),
        unit: if us { "F" } else { "C" }.into(),
    };
    let _ = store::set("weatherNow", &sky).await;
    Some(sky)
}

/// A diver's watch face: fluted bezel, lume plots, Mercedes hour hand, a
/// sweeping seconds hand, the date under a cyclops at 3. The hands turn on
/// CSS animations started at the current time, so no timer ticks.
// ponytail: the date window is set at load; a new tab left open past midnight shows yesterday.
#[component]
fn Clock(
    pomodoro: ReadSignal<Option<Pomodoro>>,
    tick: RwSignal<i64>,
    todos: ReadSignal<Vec<Todo>>,
    log: ReadSignal<ActivityLog>,
) -> impl IntoView {
    let d = js_sys::Date::new_0();
    let secs = d.get_seconds() as f64 + d.get_milliseconds() as f64 / 1000.0;
    let mins = d.get_minutes() as f64 * 60.0 + secs;
    let hours = (d.get_hours() % 12) as f64 * 3600.0 + mins;
    let day = d.get_date();
    // The break room: theme.css swaps the palette on html[data-phase="break"].
    Effect::new(move |_| {
        let on_break = pomodoro.with(|p| p.as_ref().is_some_and(|p| p.phase == PomPhase::Break));
        if let Some(root) = document().document_element() {
            let _ = if on_break {
                root.set_attribute("data-phase", "break")
            } else {
                root.remove_attribute("data-phase")
            };
        }
    });
    // None while asking; Some(None) when there is no location or no answer.
    let sky = RwSignal::new(None::<Option<SkyNow>>);
    leptos::task::spawn_local(async move { sky.set(Some(sky_now().await)) });

    let polar = |deg: f64, r: f64| {
        let a = deg.to_radians();
        (100.0 + r * a.sin(), 100.0 - r * a.cos())
    };
    let flutes = (0..120)
        .map(|i| {
            let (x1, y1) = polar(i as f64 * 3.0, 88.0);
            let (x2, y2) = polar(i as f64 * 3.0, 95.0);
            view! { <line class="clock-flute" x1=x1 y1=y1 x2=x2 y2=y2 /> }
        })
        .collect_view();
    let ticks = (0..60)
        .filter(|i| i % 5 != 0)
        .map(|i| {
            let (x1, y1) = polar(i as f64 * 6.0, 80.0);
            let (x2, y2) = polar(i as f64 * 6.0, 84.0);
            view! { <line class="clock-tick" x1=x1 y1=y1 x2=x2 y2=y2 /> }
        })
        .collect_view();
    // 12 a triangle, 6 and 9 batons, 3 the date, the rest round plots.
    let indices = (1..12).filter(|&h| h != 3).map(|h| {
        let deg = h as f64 * 30.0;
        if h == 6 || h == 9 {
            view! { <rect class="clock-lume" x="96" y="16" width="8" height="22" rx="1" transform=format!("rotate({deg} 100 100)") /> }.into_any()
        } else {
            let (cx, cy) = polar(deg, 74.0);
            view! { <circle class="clock-lume" cx=cx cy=cy r="6" /> }.into_any()
        }
    }).collect_view();

    // The time left, on the bezel like a dive timer: from the minute hand now to the phase end.
    let arc = move || {
        let p = pomodoro.get()?;
        let minute_deg = |ms: i64| {
            let d = js_sys::Date::new(&JsValue::from_f64(ms as f64));
            (d.get_minutes() as f64 + d.get_seconds() as f64 / 60.0) * 6.0
        };
        let t = tick.get();
        if t >= p.ends_at {
            return None;
        }
        let (a, b) = (minute_deg(t), minute_deg(p.ends_at));
        let sweep = (b - a).rem_euclid(360.0);
        let (x1, y1) = polar(a, 91.5);
        let (x2, y2) = polar(b, 91.5);
        let d = format!(
            "M{x1:.2} {y1:.2} A91.5 91.5 0 {} 1 {x2:.2} {y2:.2}",
            (sweep > 180.0) as u8
        );
        Some(view! { <path class="clock-pomo-arc" d=d /> })
    };

    view! {
        <section class="clock" aria-label="Clock and weather">
            <svg class="clock-face" viewBox="0 0 200 200" role="img" aria-label="Analog clock" style=format!("--s: {secs}; --m: {mins}; --h: {hours}")>
                <circle class="clock-case" cx="100" cy="100" r="98" />
                <circle class="clock-bezel" cx="100" cy="100" r="96" />
                {flutes}
                {arc}
                <circle class="clock-dial" cx="100" cy="100" r="86" />
                {ticks}
                <polygon class="clock-lume" points="88,14 112,14 100,38" />
                {indices}
                <rect class="clock-cyclops" x="139" y="90" width="26" height="20" rx="3" />
                <rect class="clock-date" x="142" y="92" width="20" height="16" rx="1" />
                <text class="clock-date-num" x="152" y="104.5" text-anchor="middle" font-size="12">{day}</text>
                <text class="clock-word" x="100" y="58" text-anchor="middle" font-size="7">"READER"</text>

                <g class="clock-hand clock-hand-h">
                    <rect x="97" y="56" width="6" height="50" rx="1" />
                    <circle class="clock-lume clock-merc" cx="100" cy="62" r="9" />
                    <path class="clock-merc-spoke" d="M100 62 V53 M100 62 L92.2 66.5 M100 62 L107.8 66.5" />
                    <polygon points="94,53 106,53 100,42" />
                </g>
                <g class="clock-hand clock-hand-m">
                    <polygon points="97,110 103,110 103,30 100,22 97,30" />
                    <rect class="clock-lume" x="98.5" y="34" width="3" height="56" />
                </g>
                <g class="clock-hand clock-hand-s">
                    <line x1="100" y1="122" x2="100" y2="20" />
                    <circle class="clock-lume clock-seconds-plot" cx="100" cy="44" r="5" />
                </g>
                <circle class="clock-pin" cx="100" cy="100" r="4" />
            </svg>
            <div class="clock-sky">
                {move || match sky.get() {
                    None => ().into_any(),
                    Some(Some(s)) => view! {
                        <p class="clock-temp">{format!("{}°{}", s.temp.round(), s.unit)}</p>
                        <p class="hint">{sky_label(s.code)}</p>
                    }.into_any(),
                    Some(None) => view! { <p class="hint">"No weather: location is off or offline."</p> }.into_any(),
                }}
            </div>
            <TodayStats todos=todos log=log />
        </section>
    }
}

const FEED_FRESH_MS: i64 = 15 * 60 * 1000;

#[derive(Serialize, Deserialize)]
struct CachedFeed {
    at: i64,
    items: Vec<FeedItem>,
}

/// The Hacker News front page, cached for a quarter hour.
async fn hn_items() -> Option<Vec<FeedItem>> {
    let cached = store::get::<Option<CachedFeed>>("hnFeed")
        .await
        .ok()
        .flatten();
    if let Some(c) = cached.as_ref().filter(|c| now() - c.at < FEED_FRESH_MS) {
        return Some(c.items.clone());
    }
    let fresh = async {
        let res: web_sys::Response =
            JsFuture::from(chrome::fetch(HN_RSS, &JsValue::UNDEFINED).ok()?)
                .await
                .ok()?
                .unchecked_into();
        let text = JsFuture::from(res.text().ok()?).await.ok()?.as_string()?;
        Some(rss_items(&text)).filter(|i| !i.is_empty())
    }
    .await;
    match fresh {
        Some(items) => {
            let _ = store::set(
                "hnFeed",
                &CachedFeed {
                    at: now(),
                    items: items.clone(),
                },
            )
            .await;
            Some(items)
        }
        // Offline: a stale list beats none.
        None => cached.map(|c| c.items),
    }
}

#[component]
fn HnFeed() -> impl IntoView {
    let items = RwSignal::new(None::<Option<Vec<FeedItem>>>);
    leptos::task::spawn_local(async move { items.set(Some(hn_items().await)) });
    view! {
        <section class="feed" aria-labelledby="feed-head">
            <h2 id="feed-head" class="label">"Hacker News"</h2>
            {move || match items.get() {
                None => ().into_any(),
                Some(None) => view! { <p class="hint">"Hacker News did not answer."</p> }.into_any(),
                Some(Some(list)) => view! {
                    <ol class="feed-list">
                        {list.into_iter().map(|it| view! {
                            <li>
                                <a class="feed-link" href=it.link>{it.title}</a>
                                {it.comments.map(|c| view! { <a class="hint feed-comments" href=c>"comments"</a> })}
                            </li>
                        }).collect_view()}
                    </ol>
                }.into_any(),
            }}
        </section>
    }
}

/* ---------- Today, in numbers ---------- */

/// What today has added up to so far, beside the clock: focus, to-dos,
/// papers, and the next reminder.
#[component]
fn TodayStats(todos: ReadSignal<Vec<Todo>>, log: ReadSignal<ActivityLog>) -> impl IntoView {
    let day = move || {
        log.with(|l| {
            l.get(&local_date(now()).to_string())
                .cloned()
                .unwrap_or_default()
        })
    };
    let todo_line = move || {
        let list = keep_today(todos.get(), today_start());
        let done = list.iter().filter(|t| t.done_at.is_some()).count();
        if list.is_empty() {
            "None yet".to_string()
        } else {
            format!("{done} of {} done", list.len())
        }
    };
    let next = move || {
        let t_now = now();
        todos
            .with(|l| {
                l.iter()
                    .filter(|t| t.done_at.is_none())
                    .filter_map(|t| t.due_at.filter(|&d| d > t_now).map(|d| (d, t.text.clone())))
                    .min_by_key(|(d, _)| *d)
            })
            .map(|(d, text)| {
                let (_, _, _, h, mi) = local_parts(d);
                format!("{h:02}:{mi:02} {text}")
            })
            .unwrap_or_else(|| "Nothing scheduled".into())
    };
    view! {
        <dl class="today-stats" aria-label="Today so far">
            <div><dt class="label">"Focus"</dt><dd>{move || {
                let d = day();
                format!("{} · {} min", plural(d.focus, "session"), d.clocked.unwrap_or(0))
            }}</dd></div>
            <div><dt class="label">"To-dos"</dt><dd>{todo_line}</dd></div>
            <div><dt class="label">"Papers"</dt><dd>{move || format!("{} read", plural(day().papers.len() as u32, "paper"))}</dd></div>
            <div><dt class="label">"Next"</dt><dd class="today-next">{next}</dd></div>
        </dl>
    }
}

/* ---------- Pomodoro ---------- */

#[wasm_bindgen(module = "/js/pip-timer.mjs")]
extern "C" {
    #[wasm_bindgen(js_name = canFloat)]
    fn can_float() -> bool;
    #[wasm_bindgen(js_name = floatTimer, catch)]
    async fn float_timer() -> Result<JsValue, JsValue>;
}

/// Choose up to three board tasks; the worker owns the alarm, blocking and bell.
#[component]
fn PomodoroPanel(
    pomodoro: ReadSignal<Option<Pomodoro>>,
    tick: RwSignal<i64>,
    todos: ReadSignal<Vec<Todo>>,
) -> impl IntoView {
    let planning = RwSignal::new(false);
    let selected = RwSignal::new(Vec::<String>::new());
    let video = RwSignal::new(String::new());
    let error = RwSignal::new(String::new());
    let busy = RwSignal::new(false);
    let open_tasks = Memo::new(move |_| {
        let mut list: Vec<Todo> = todos
            .get()
            .into_iter()
            .filter(|t| t.done_at.is_none())
            .collect();
        list.sort_by_key(|t| (t.started_at.is_none(), t.rank, t.due_at.is_none(), t.due_at));
        list
    });
    let begin = move || {
        if busy.get_untracked() {
            return;
        }
        busy.set(true);
        error.set(String::new());
        let ids = selected.get_untracked();
        let video = video.get_untracked();
        leptos::task::spawn_local(async move {
            match begin_round(ids, video).await {
                Ok(()) => {
                    planning.try_set(false);
                }
                Err(e) => {
                    error.try_set(js_sys::Error::from(e).message().into());
                }
            }
            busy.try_set(false);
        });
    };
    let stop = move |_| {
        leptos::task::spawn_local(async move {
            if change_tasks(|_, round| {
                *round = None;
                Ok(())
            })
            .await
            .is_err()
            {
                error.try_set("Couldn't stop the round. Try again.".into());
            }
        });
    };
    view! {
        <div class="pomo">
            <Show when=move || error.with(|e| !e.is_empty())><p role="alert">{move || error.get()}</p></Show>
            {move || match pomodoro.get() {
                None if planning.get() => view! {
                    <form class="pomo-plan" on:submit=move |e| { e.prevent_default(); begin(); }>
                        <p class="label">"Choose up to three tasks for 25 minutes"</p>
                        <Show when=move || open_tasks.with(Vec::is_empty)>
                            <p class="hint">"Add a to-do below, then choose it here."</p>
                        </Show>
                        <ul class="pomo-tasks">
                            {move || open_tasks.get().into_iter().map(|t| {
                                let check_id = t.id.clone();
                                let disable_id = t.id.clone();
                                view! {
                                    <li><label class="todo-check">
                                        <input type="checkbox" prop:checked=move || selected.with(|s| s.contains(&check_id))
                                            disabled=move || busy.get() || selected.with(|s| s.len() >= MAX_TASKS && !s.contains(&disable_id))
                                            on:change=move |e| {
                                                let checked = event_target_checked(&e);
                                                selected.update(|ids| {
                                                    ids.retain(|id| id != &t.id);
                                                    if checked && ids.len() < MAX_TASKS { ids.push(t.id.clone()); }
                                                });
                                            } />
                                        <span>{t.text}</span>
                                    </label></li>
                                }
                            }).collect_view()}
                        </ul>
                        <label class="hint" for="study-video">"Study video (optional): allow only this YouTube video during focus"</label>
                        <input id="study-video" class="pomo-task-input" type="url" placeholder="https://www.youtube.com/watch?v=…"
                            prop:value=move || video.get() on:input=move |e| video.set(event_target_value(&e)) />
                        <div class="pomo-actions">
                            <button type="submit" class="fc-primary-btn" disabled=move || busy.get() || selected.with(Vec::is_empty)>"Start focus"</button>
                            <button type="button" class="edition-pill" disabled=move || busy.get() on:click=move |_| planning.set(false)>"Cancel"</button>
                        </div>
                    </form>
                }.into_any(),
                None => view! {
                    <button type="button" class="fc-primary-btn" on:click=move |_| {
                        selected.set(open_tasks.get_untracked().into_iter().take(MAX_TASKS).map(|t| t.id).collect());
                        error.set(String::new());
                        planning.set(true);
                    }>"Start a focus round"</button>
                }.into_any(),
                Some(p) => {
                    let on_break = p.phase == PomPhase::Break;
                    let ends = p.ends_at;
                    view! {
                        <p class="pomo-phase">
                            <span class="label">{if on_break { "Break" } else { "Focus" }}</span>
                            <span class="pomo-left" aria-live="off">{move || format!("{} left", left_label(ends - tick.get()))}</span>
                        </p>
                        {on_break.then(|| view! {
                            <div class="pomo-breath" aria-hidden="true"><span></span></div>
                            <p class="hint">"Breathe in for 4, out for 6. Look at something far away."</p>
                        })}
                        <ul class="pomo-tasks">
                            {p.tasks.into_iter().enumerate().map(|(i, t)| {
                                let label = t.text.clone();
                                let toggle = move |e| {
                                    let checked = event_target_checked(&e);
                                    let (id, text) = (t.todo_id.clone(), t.text.clone());
                                    leptos::task::spawn_local(async move {
                                        if change_tasks(move |list, round| {
                                            if let Some(id) = id {
                                                if round.as_ref().is_some_and(|p| p.tasks.iter().any(|t| t.todo_id.as_ref() == Some(&id))) {
                                                    if let Some(todo) = list.iter_mut().find(|t| t.id == id) { todo.done_at = checked.then(now); }
                                                }
                                            } else if let Some(task) = round.as_mut().and_then(|p| p.tasks.get_mut(i)).filter(|t| t.todo_id.is_none() && t.text == text) {
                                                task.done = checked;
                                            }
                                            Ok(())
                                        }).await.is_err() { error.try_set("Couldn't save the task. Try again.".into()); }
                                    });
                                };
                                view! { <li class:todo--done=t.done><label class="todo-check">
                                    <input type="checkbox" prop:checked=t.done on:change=toggle />
                                    <span>{label}</span>
                                </label></li> }
                            }).collect_view()}
                        </ul>
                        {p.study_video.filter(|_| !on_break).map(|id| view! {
                            <a class="hint" href=reader_core::youtube::watch_url(&id) target="_blank" rel="noopener">"Open your allowed study video"</a>
                        })}
                        <div class="pomo-actions">
                            <button type="button" class="edition-pill" on:click=stop>{if on_break { "End break" } else { "Stop" }}</button>
                            {can_float().then(|| view! {
                                <button type="button" class="edition-pill" title="Keep the time left in a small window over your other tabs" on:click=move |_| {
                                    leptos::task::spawn_local(async move {
                                        if float_timer().await.is_err() {
                                            error.try_set("Couldn't open the floating timer.".into());
                                        }
                                    });
                                }>"Float timer"</button>
                            })}
                        </div>
                    }.into_any()
                }
            }}
        </div>
    }
}

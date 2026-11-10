//! The papers page: one deck of cards per alphaXiv folder. Each card carries
//! the title, byline and a brass progress bar.
//! Arrow keys walk the books (one tab stop for the whole case), Enter pulls a
//! book out, M moves it (drag does too), and the New-arrivals cart shelves
//! papers from alphaXiv's Hot and For You feeds with S.

use super::{send, use_storage};
use crate::chrome;
use leptos::prelude::*;
use reader_core::annotations::annotation_doc_key;
use reader_core::constants::{LEXICON_PAGE_PATH, NEWTAB_PAGE_PATH};
use reader_core::explain::ExplainBacks;
use reader_core::papers::group_by_folder;
use reader_core::pdf::paper_open_url;
use reader_core::shelf::{step, Arrival};
use reader_core::types::{Folder, Paper};
use serde_json::json;
use wasm_bindgen::JsCast;

/// What the move menu is for: a book already shelved, or one from the cart.
#[derive(Clone, PartialEq)]
enum Shelving {
    Move { paper: Box<Paper>, from: String },
    Save { id: String, title: String },
}

fn focus_id(id: &str) {
    if let Some(el) = document()
        .get_element_by_id(id)
        .and_then(|e| e.dyn_into::<web_sys::HtmlElement>().ok())
    {
        let _ = el.focus();
    }
}

fn book_id(s: usize, b: usize) -> String {
    format!("book-{s}-{b}")
}

fn byline(p: &Paper) -> String {
    [
        p.authors.clone(),
        p.year.map(|y| y.to_string()).unwrap_or_default(),
    ]
    .into_iter()
    .filter(|s| !s.is_empty())
    .collect::<Vec<_>>()
    .join(" · ")
}

fn progress_label(p: &Paper) -> String {
    match p.progress_percent.round() as i64 {
        0 => "not started".into(),
        n if n >= 100 => "finished".into(),
        n => format!("{n}% read"),
    }
}

#[oxichrome::page(path = "src/pages/papers/index.html", title = "Papers", css = ["assets/theme.css", "assets/papers.css"])]
pub fn Papers() -> impl IntoView {
    super::use_theme();
    let (papers, _) = use_storage::<Vec<Paper>>("papers");
    let (folders, _) = use_storage::<Vec<Folder>>("folders");
    let (explains, _) = use_storage::<ExplainBacks>("explainBacks");
    let (lexicon, _) = use_storage::<reader_core::lexicon::Lexicon>("lexicon");
    // The shelf is alphaXiv's: refresh it (at most every two minutes) whenever this page opens.
    leptos::task::spawn_local(async {
        send(json!({ "type": "ALPHAXIV_SYNC" })).await;
    });
    let arrivals = RwSignal::new(None::<(Vec<Arrival>, Vec<Arrival>)>);
    leptos::task::spawn_local(async move {
        let r = send(json!({ "type": "ALPHAXIV_ARRIVALS" })).await;
        if r["ok"] == true {
            let list = |k: &str| serde_json::from_value(r[k].clone()).unwrap_or_default();
            arrivals.set(Some((list("hot"), list("forYou"))));
        }
    });

    // Shelves in folder order, each with its books.
    let shelves = Memo::new(move |_| {
        let by = papers.with(|p| group_by_folder(p));
        folders.with(|f| {
            f.iter()
                .map(|f| (f.clone(), by.get(&f.id).cloned().unwrap_or_default()))
                .collect::<Vec<_>>()
        })
    });
    let at = RwSignal::new((0usize, 0usize));
    // Keep the tab stop on a real book as shelves change.
    Effect::new(move |_| {
        let lens: Vec<usize> = shelves.with(|s| s.iter().map(|(_, b)| b.len()).collect());
        let (s, b) = at.get_untracked();
        if lens.get(s).is_none_or(|&n| b >= n) {
            let first = lens.iter().position(|&n| n > 0).unwrap_or(0);
            at.set((first, 0));
        }
    });

    let card = RwSignal::new(None::<(Paper, String, (usize, usize))>);
    let menu = RwSignal::new(None::<Shelving>);
    let status = RwSignal::new(String::new());

    let open_menu = move |m: Shelving| {
        menu.set(Some(m));
        request_animation_frame(|| focus_id("move-menu-first"));
    };
    let shelve = move |m: Shelving, folder: Folder| {
        menu.set(None);
        card.set(None);
        let (msg, done) = match &m {
            Shelving::Move { paper, from } => (
                json!({ "type": "ALPHAXIV_MOVE", "paperId": paper.id, "from": from, "to": folder.id }),
                format!("Moved to {}.", folder.name),
            ),
            Shelving::Save { id, .. } => (
                json!({ "type": "ALPHAXIV_SAVE", "paperId": id, "folderId": folder.id }),
                format!("Shelved in {}.", folder.name),
            ),
        };
        let (doing, not_done) = match m {
            Shelving::Move { .. } => (format!("Moving to {}…", folder.name), "Not moved"),
            Shelving::Save { .. } => (format!("Shelving in {}…", folder.name), "Not shelved"),
        };
        status.set(doing);
        leptos::task::spawn_local(async move {
            let r = send(msg).await;
            status.set(if r["ok"] == true {
                done
            } else {
                let why = r["message"].as_str().unwrap_or("alphaXiv did not answer.");
                format!("{not_done}: {why}")
            });
        });
    };

    let on_case_key = move |e: web_sys::KeyboardEvent| {
        if card.with_untracked(Option::is_some) || menu.with_untracked(Option::is_some) {
            return;
        }
        let key = e.key();
        let (s, b) = at.get_untracked();
        if key == "m" || key == "M" {
            if let Some((f, books)) = shelves.with_untracked(|sh| sh.get(s).cloned()) {
                if let Some(p) = books.get(b) {
                    e.prevent_default();
                    open_menu(Shelving::Move {
                        paper: Box::new(p.clone()),
                        from: f.id,
                    });
                }
            }
            return;
        }
        let lens: Vec<usize> = shelves.with_untracked(|s| s.iter().map(|(_, b)| b.len()).collect());
        if let Some(next) = step(&lens, (s, b), &key) {
            e.prevent_default();
            at.set(next);
            focus_id(&book_id(next.0, next.1));
        }
    };

    let close_card = move || {
        if let Some((_, _, (s, b))) = card.get_untracked() {
            card.set(None);
            request_animation_frame(move || focus_id(&book_id(s, b)));
        }
    };

    view! {
        <div id="root">
            <div class="library grid">
                <header class="library-masthead">
                    <nav class="library-nav">
                        <a class="ghost-btn" href=chrome::get_url(NEWTAB_PAGE_PATH)>"← Today"</a>
                        <a class="ghost-btn" href=chrome::get_url(LEXICON_PAGE_PATH)>"Lexicon"</a>
                    </nav>
                    <h1>"Papers"</h1>
                    <p class="library-keys" aria-hidden="true">"Arrows to browse · Enter to pull out · M to move"</p>
                </header>
                <p class="library-status" role="status">{move || status.get()}</p>
                <section class="bookcase" aria-label="Your shelves" on:keydown=on_case_key>
                    <Show when=move || folders.with(Vec::is_empty)>
                        <p class="library-hint">"Sign in to alphaXiv in Settings to bring in your library."</p>
                    </Show>
                    {move || shelves.get().into_iter().enumerate().map(|(s, (folder, books))| {
                        let heading = format!("folder-{}", folder.id);
                        let labelled_by = heading.clone();
                        let target = folder.clone();
                        view! {
                            <section class="shelf" aria-labelledby=labelled_by
                                on:dragover=|e: web_sys::DragEvent| e.prevent_default()
                                on:drop=move |e: web_sys::DragEvent| {
                                    e.prevent_default();
                                    let Some(data) = e.data_transfer().and_then(|d| d.get_data("application/x-paper").ok()) else { return };
                                    let Some((paper_id, from)) = data.split_once('\n') else { return };
                                    if from == target.id { return; }
                                    let Some(paper) = papers.with_untracked(|p| p.iter().find(|p| p.id == paper_id).cloned()) else { return };
                                    shelve(Shelving::Move { paper: Box::new(paper), from: from.to_string() }, target.clone());
                                }>
                                <h2 id=heading>{folder.name.clone()}<span class="shelf-count">{books.len()}</span></h2>
                                <ul class="shelf-row">
                                    {books.is_empty().then(|| view! { <li class="shelf-empty">"Nothing on this shelf yet."</li> })}
                                    {books.into_iter().enumerate().map(|(b, p)| {
                                        let marks = explains.with(|e| lexicon.with(|l| reader_core::game::marks(&p, e, l)));
                                        let label = format!("{}. {}. {}.", p.title, progress_label(&p), reader_core::game::marks_label(marks));
                                        let on = [marks.0, marks.1, marks.2 >= reader_core::game::TERMS_GOAL];
                                        let drag = format!("{}\n{}", p.id, folder.id);
                                        let from = folder.id.clone();
                                        view! {
                                            <li>
                                                <button type="button" class="book" id=book_id(s, b)
                                                    tabindex=move || if at.get() == (s, b) { "0" } else { "-1" }
                                                    style=format!("--p: {}%", p.progress_percent.clamp(0.0, 100.0).round())
                                                    aria-label=label aria-keyshortcuts="M" draggable="true"
                                                    on:focus=move |_| at.set((s, b))
                                                    on:dragstart=move |e: web_sys::DragEvent| {
                                                        if let Some(d) = e.data_transfer() { let _ = d.set_data("application/x-paper", &drag); }
                                                    }
                                                    on:click={
                                                        let p = p.clone();
                                                        move |_| { at.set((s, b)); card.set(Some((p.clone(), from.clone(), (s, b)))); request_animation_frame(|| focus_id("book-card-continue")); }
                                                    }>
                                                    <span class="book-title" aria-hidden="true">{p.title.clone()}</span>
                                                    <span class="book-meta" aria-hidden="true">{byline(&p)}</span>
                                                    <span class="book-foot" aria-hidden="true">
                                                        <span class="book-bar"></span>
                                                        <span class="book-foot-line">
                                                            {progress_label(&p)}
                                                            <span class="book-marks">{on.map(|on| view! { <i data-on=on.then_some("")></i> })}</span>
                                                        </span>
                                                    </span>
                                                </button>
                                            </li>
                                        }
                                    }).collect_view()}
                                </ul>
                            </section>
                        }
                    }).collect_view()}
                </section>

                {move || card.get().map(|(p, from, _)| {
                    let key = annotation_doc_key(&p.url);
                    let gaps: Vec<(String, Option<u32>)> = explains.with(|e| {
                        e.get(&key).and_then(|l| l.last()).map(|x| x.gaps().map(|g| (format!("{}: {}", g.part.label(), g.gap), g.page)).collect()).unwrap_or_default()
                    });
                    let stopped = match (&p.pdf, p.left_off.is_empty()) {
                        (_, false) => p.left_off.clone(),
                        (Some(pdf), true) => format!("Page {} of {}", pdf.page, pdf.page_count),
                        (None, true) => "Not opened yet".into(),
                    };
                    let marks = reader_core::game::marks_label(explains.with(|e| lexicon.with(|l| reader_core::game::marks(&p, e, l))));
                    let byline = byline(&p);
                    let href = paper_open_url(&p, false, &chrome::get_url(""));
                    let mv = Shelving::Move { paper: Box::new(p.clone()), from };
                    view! {
                        <section class="book-card" role="dialog" aria-labelledby="book-card-title" on:keydown=move |e: web_sys::KeyboardEvent| {
                            if e.key() == "Escape" { e.stop_propagation(); close_card(); }
                        }>
                            <h2 id="book-card-title">{p.title.clone()}</h2>
                            {(!byline.is_empty()).then(|| view! { <p class="book-card-byline">{byline}</p> })}
                            <dl class="book-card-facts">
                                <dt>"Progress"</dt><dd>{progress_label(&p)}</dd>
                                <dt>"Where you stopped"</dt><dd>{stopped}</dd>
                                <dt>"Marks"</dt><dd>{marks}</dd>
                            </dl>
                            {(!gaps.is_empty()).then(|| view! {
                                <h3 class="define-label">"Still open from your last explain-back"</h3>
                                <ul class="book-card-gaps">
                                    {gaps.into_iter().map(|(g, page)| view! {
                                        <li>{g}{page.map(|n| format!(" (page {n})"))}</li>
                                    }).collect_view()}
                                </ul>
                            })}
                            <div class="book-card-actions">
                                <a id="book-card-continue" class="fc-primary-btn" href=href>"Continue reading"</a>
                                <button type="button" class="ghost-btn" aria-keyshortcuts="M" on:click=move |_| open_menu(mv.clone())>"Move to shelf"</button>
                                <button type="button" class="ghost-btn" on:click=move |_| close_card()>"Close"</button>
                                <kbd>"Esc"</kbd>
                            </div>
                        </section>
                    }
                })}

                {move || menu.get().map(|m| {
                    let (title, from) = match &m {
                        Shelving::Move { paper, from } => (paper.title.clone(), Some(from.clone())),
                        Shelving::Save { title, .. } => (title.clone(), None),
                    };
                    let targets: Vec<Folder> = folders.get().into_iter().filter(|f| Some(&f.id) != from.as_ref()).collect();
                    let back = move || {
                        menu.set(None);
                        let (s, b) = at.get_untracked();
                        request_animation_frame(move || {
                            if card.with_untracked(Option::is_some) { focus_id("book-card-continue") } else { focus_id(&book_id(s, b)) }
                        });
                    };
                    view! {
                        <section class="move-menu" role="dialog" aria-labelledby="move-menu-title" on:keydown=move |e: web_sys::KeyboardEvent| {
                            if e.key() == "Escape" { e.stop_propagation(); back(); }
                        }>
                            <h2 id="move-menu-title">{format!("Put \u{201c}{title}\u{201d} on")}</h2>
                            <ul>
                                {targets.into_iter().enumerate().map(|(i, f)| {
                                    let m = m.clone();
                                    let name = f.name.clone();
                                    view! { <li><button type="button" class="ghost-btn" id=(i == 0).then_some("move-menu-first") on:click=move |_| shelve(m.clone(), f.clone())>{name}</button></li> }
                                }).collect_view()}
                            </ul>
                            <button type="button" class="ghost-btn" on:click=move |_| back()>"Cancel"</button>
                        </section>
                    }
                })}

                {move || arrivals.get().map(|(hot, for_you)| {
                    let shelved = move |a: &Arrival| papers.with(|p| p.iter().any(|p| p.id == a.id && !p.folder_ids.is_empty()));
                    let list = move |name: &'static str, items: Vec<Arrival>| {
                        let items: Vec<Arrival> = items.into_iter().filter(|a| !shelved(a)).collect();
                        view! {
                            <div class="cart-list">
                                <h3 class="define-label">{name}</h3>
                                {items.is_empty().then(|| view! { <p class="library-hint">"Nothing new here."</p> })}
                                <ul>
                                    {items.into_iter().map(|a| {
                                        let save = Shelving::Save { id: a.id.clone(), title: a.title.clone() };
                                        let on_key = save.clone();
                                        view! {
                                            <li class="cart-item" on:keydown=move |e: web_sys::KeyboardEvent| {
                                                if e.key() == "s" || e.key() == "S" { e.prevent_default(); open_menu(on_key.clone()); }
                                            }>
                                                <a href=format!("https://www.alphaxiv.org/abs/{}", a.id) target="_blank" rel="noopener">{a.title.clone()}</a>
                                                <button type="button" class="ghost-btn" aria-keyshortcuts="S" aria-label=format!("Shelve {}", a.title) on:click=move |_| open_menu(save.clone())>"Shelve"</button>
                                            </li>
                                        }
                                    }).collect_view()}
                                </ul>
                            </div>
                        }
                    };
                    view! {
                        <section class="cart" aria-labelledby="cart-heading">
                            <h2 id="cart-heading">"New arrivals"</h2>
                            <p class="library-hint">"From alphaXiv. S shelves the one you are on."</p>
                            <div class="cart-lists">
                                {list("Hot", hot)}
                                {list("For you", for_you)}
                            </div>
                        </section>
                    }
                })}
            </div>
        </div>
    }
}

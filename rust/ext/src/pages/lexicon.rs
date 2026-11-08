//! The lexicon: terms kept while reading, as a graph that settles like a
//! physical thing. Nodes are buttons over an SVG of edges, both placed in
//! screen pixels, so labels stay one readable size at any zoom. The layout
//! rules (forces, camera) are reader_core::graph_layout; the data rules are
//! reader_core::lexicon.

use super::ai::Markdown;
use super::use_storage;
use crate::js::now;
use crate::{chrome, claude, store};
use leptos::html;
use leptos::prelude::*;
use reader_core::ai::{route, Route};
use reader_core::constants::PAPERS_PAGE_PATH;
use reader_core::graph_layout::{Cam, Sim};
use reader_core::lexicon::{
    add_term, link_request, merge_links, parse_links, remove_edge, remove_term, source_reader_path,
    unlinked, Lexicon, Source,
};
use reader_core::types::Paper;
use std::collections::HashMap;
use wasm_bindgen::JsCast;

/// Linking reads the whole lexicon; give it longer than a question.
const LINK_TIMEOUT_MS: i32 = 60_000;
/// Space kept clear around the graph when it is fitted to the stage.
const FIT_PAD: f64 = 72.0;
/// A press that moves less than this is a click, not a drag.
const DRAG_SLOP: f64 = 4.0;
const GLIDE_MS: f64 = 420.0;
/// Half a popover's width, to keep it on the stage.
const POP_HALF: f64 = 170.0;

/// The reader's "Add to lexicon".
pub async fn keep_term(label: String, source: Source) {
    edit(move |lex| {
        add_term(lex, &label, source);
    })
    .await;
}

async fn edit(f: impl FnOnce(&mut Lexicon)) {
    // ponytail: read-modify-write without a lock; two tabs writing in the same tick can drop one change.
    let mut lex: Lexicon = store::get("lexicon").await.unwrap_or_default();
    f(&mut lex);
    let _ = store::set("lexicon", &lex).await;
}

fn reduced_motion() -> bool {
    window()
        .match_media("(prefers-reduced-motion: reduce)")
        .ok()
        .flatten()
        .is_some_and(|m| m.matches())
}

#[derive(Clone, PartialEq)]
enum Sel {
    Term(String),
    Edge(String, String),
}

enum Drag {
    Node {
        id: String,
        x0: f64,
        y0: f64,
        moved: bool,
    },
    Pan {
        x0: f64,
        y0: f64,
        from: Cam,
        moved: bool,
    },
}

/// The live layout and the camera, shared by everything on the stage.
#[derive(Clone, Copy)]
struct Graph {
    sim: StoredValue<Sim>,
    ids: StoredValue<Vec<String>>,
    /// Layout positions by term id, published once per frame
    pos: RwSignal<HashMap<String, (f64, f64)>>,
    running: StoredValue<bool>,
    cam: RwSignal<Cam>,
    /// The camera follows the whole graph until the reader pans or zooms.
    fit: RwSignal<bool>,
    size: RwSignal<(f64, f64)>,
    /// Bumped to cancel a camera glide in flight
    glide: StoredValue<u64>,
    stage: NodeRef<html::Div>,
}

impl Graph {
    fn index(self, id: &str) -> Option<usize> {
        self.ids.with_value(|ids| ids.iter().position(|i| i == id))
    }

    fn publish(self) {
        let Some(map) = self.sim.try_with_value(|s| {
            self.ids.with_value(|ids| {
                ids.iter()
                    .cloned()
                    .zip(s.nodes.iter().map(|p| (p.x, p.y)))
                    .collect::<HashMap<_, _>>()
            })
        }) else {
            return;
        };
        self.pos.try_set(map);
        if self.fit.get_untracked() {
            self.refit();
        }
        self.paint();
    }

    /// Move every node and edge to where the layout and camera put them. Written
    /// straight to the DOM once a frame: a reactive binding per coordinate cost
    /// 300 terms most of their frame rate.
    fn paint(self) {
        let Some(stage) = self.stage.get_untracked() else {
            return;
        };
        let Ok(list) = stage.query_selector_all(".lex-node, line[data-a]") else {
            return;
        };
        let (w, h) = self.size.get_untracked();
        let cam = self.cam.get_untracked();
        self.pos.with_untracked(|m| {
            let at = |id: Option<String>| {
                id.and_then(|id| m.get(&id).map(|&(x, y)| cam.to_screen(x, y, w, h)))
            };
            for i in 0..list.length() {
                let Some(el) = list
                    .item(i)
                    .and_then(|n| n.dyn_into::<web_sys::Element>().ok())
                else {
                    continue;
                };
                if let Some((x, y)) = at(el.get_attribute("data-id")) {
                    if let Some(el) = el.dyn_ref::<web_sys::HtmlElement>() {
                        let _ = el.style().set_property("transform", &node_transform(x, y));
                    }
                } else if let (Some((x1, y1)), Some((x2, y2))) = (
                    at(el.get_attribute("data-a")),
                    at(el.get_attribute("data-b")),
                ) {
                    for (k, v) in [("x1", x1), ("y1", y1), ("x2", x2), ("y2", y2)] {
                        let _ = el.set_attribute(k, &format!("{v:.1}"));
                    }
                }
            }
        });
    }

    fn refit(self) {
        let (w, h) = self.size.get_untracked();
        let cam = self.sim.with_value(|s| Cam::fit(s, w, h, FIT_PAD));
        self.cam.set(cam);
    }

    /// Start the animation loop if it is not already running.
    fn kick(self) {
        if self.running.try_get_value() != Some(false) {
            return;
        }
        self.running.set_value(true);
        self.frame();
    }

    fn frame(self) {
        // Two ticks a frame: a fresh graph comes to rest in about two and a half seconds.
        let Some(done) = self.sim.try_update_value(|s| {
            s.tick();
            s.tick();
            s.settled()
        }) else {
            return; // the page is gone
        };
        self.publish();
        if done {
            self.running.set_value(false);
        } else {
            request_animation_frame(move || self.frame());
        }
    }

    /// A term's position on the stage, in px.
    fn screen(self, id: &str) -> Option<(f64, f64)> {
        let (w, h) = self.size.get();
        let cam = self.cam.get();
        self.pos
            .with(|m| m.get(id).map(|&(x, y)| cam.to_screen(x, y, w, h)))
    }

    fn stop_glide(self) {
        self.glide.update_value(|g| *g += 1);
    }

    /// Ease the camera onto a term.
    fn glide_to(self, id: &str) {
        let Some((x, y)) = self.pos.with_untracked(|m| m.get(id).copied()) else {
            return;
        };
        self.fit.set(false);
        let from = self.cam.get_untracked();
        let to = Cam {
            cx: x,
            cy: y,
            k: from.k.max(1.0),
        };
        if reduced_motion() {
            self.cam.set(to);
            return;
        }
        self.stop_glide();
        let generation = self.glide.get_value();
        let start = now();
        fn step(g: Graph, generation: u64, start: i64, from: Cam, to: Cam) {
            if g.glide.try_get_value() != Some(generation) {
                return;
            }
            let t = ((now() - start) as f64 / GLIDE_MS).min(1.0);
            g.cam.set(from.lerp(to, 1.0 - (1.0 - t).powi(3)));
            if t < 1.0 {
                request_animation_frame(move || step(g, generation, start, from, to));
            }
        }
        step(self, generation, start, from, to);
    }
}

fn node_transform(x: f64, y: f64) -> String {
    format!("translate({x:.1}px, {y:.1}px) translate(-50%, -50%)")
}

fn label_of(lex: &Lexicon, id: &str) -> String {
    lex.terms
        .iter()
        .find(|t| t.id == id)
        .map(|t| t.label.clone())
        .unwrap_or_default()
}

/// Where a popover sits for an anchor at (`x`, `y`): below it in the top half
/// of the stage, above it in the bottom half, never off the sides.
fn pop_style(x: f64, y: f64, (w, h): (f64, f64)) -> String {
    let x = x
        .max(POP_HALF.min(w / 2.0))
        .min((w - POP_HALF).max(w / 2.0));
    if y < h / 2.0 {
        format!(
            "left: {x:.0}px; top: {:.0}px; max-height: {:.0}px;",
            y + 40.0,
            h - y - 52.0
        )
    } else {
        format!(
            "left: {x:.0}px; bottom: {:.0}px; max-height: {:.0}px; transform-origin: bottom center;",
            h - y + 20.0,
            y - 32.0
        )
    }
}

#[oxichrome::page(path = "src/pages/lexicon/index.html", title = "Lexicon", css = ["assets/theme.css", "assets/lexicon.css", "assets/aiNote.css", "assets/markdown.css", "assets/katex.min.css"])]
pub fn LexiconPage() -> impl IntoView {
    super::use_theme();
    let (stored, loaded) = use_storage::<Lexicon>("lexicon");
    let stage: NodeRef<html::Div> = NodeRef::new();
    let lexicon: Signal<Lexicon> = stored.into();
    let g = Graph {
        sim: StoredValue::new(Sim::new(0, vec![], 7)),
        ids: StoredValue::new(vec![]),
        pos: RwSignal::new(HashMap::new()),
        running: StoredValue::new(false),
        cam: RwSignal::new(Cam::default()),
        fit: RwSignal::new(true),
        size: RwSignal::new((800.0, 600.0)),
        glide: StoredValue::new(0),
        stage,
    };
    let selected = RwSignal::new(None::<Sel>);
    let hovered = RwSignal::new(None::<String>);
    let opener = StoredValue::new_local(None::<web_sys::HtmlElement>);
    let drag = StoredValue::new(None::<Drag>);

    // The stage's size, now and after every resize.
    let measure = move || {
        if let Some(el) = stage.get_untracked() {
            g.size
                .set((f64::from(el.client_width()), f64::from(el.client_height())));
            if g.fit.get_untracked() {
                g.refit();
            }
        }
    };
    Effect::new(move |_| {
        if stage.get().is_some() {
            measure();
        }
    });
    let resize = window_event_listener(leptos::ev::resize, move |_| measure());
    Effect::new(move |_| {
        g.cam.track();
        g.size.track();
        if !g.running.get_value() {
            g.paint();
        }
    });

    // Rebuild the layout when terms or links change; a term already on the
    // stage keeps its place, so the graph rearranges instead of jumping.
    let shape = StoredValue::new((Vec::<String>::new(), Vec::<(usize, usize)>::new()));
    Effect::new(move |_| {
        let (ids, links) = lexicon.with(|l| {
            let ids: Vec<String> = l.terms.iter().map(|t| t.id.clone()).collect();
            let at: HashMap<&str, usize> = ids
                .iter()
                .enumerate()
                .map(|(i, id)| (id.as_str(), i))
                .collect();
            let links: Vec<(usize, usize)> = l
                .edges
                .iter()
                .filter_map(|e| Some((*at.get(e.a.as_str())?, *at.get(e.b.as_str())?)))
                .collect();
            (ids, links)
        });
        if shape.with_value(|s| s.0 == ids && s.1 == links) {
            return;
        }
        shape.set_value((ids.clone(), links.clone()));
        let old = g.pos.get_untracked();
        let mut sim = Sim::new(ids.len(), links, 7);
        let mut kept = 0;
        for (p, id) in sim.nodes.iter_mut().zip(&ids) {
            if let Some(&(x, y)) = old.get(id) {
                (p.x, p.y) = (x, y);
                kept += 1;
            }
        }
        if kept > 0 {
            sim.alpha = 0.4;
        }
        let calm = reduced_motion();
        if calm {
            sim.settle();
        }
        g.ids.set_value(ids);
        g.sim.set_value(sim);
        g.publish();
        if !calm {
            g.kick();
        }
    });

    let close = move || {
        selected.set(None);
        if let Some(el) = opener.get_value() {
            let _ = el.focus();
        }
    };
    let keys = window_event_listener(leptos::ev::keydown, move |e| {
        if e.key() == "Escape" && selected.get_untracked().is_some() {
            close();
        }
    });
    on_cleanup(move || {
        resize.remove();
        keys.remove();
    });

    let local = move |e: &web_sys::MouseEvent| -> (f64, f64) {
        stage
            .get_untracked()
            .map(|s| {
                let r = s.get_bounding_client_rect();
                (
                    f64::from(e.client_x()) - r.left(),
                    f64::from(e.client_y()) - r.top(),
                )
            })
            .unwrap_or_default()
    };
    let capture = move |e: &web_sys::PointerEvent| {
        if let Some(s) = stage.get_untracked() {
            let _ = s.set_pointer_capture(e.pointer_id());
        }
    };

    let on_down = move |e: web_sys::PointerEvent| {
        if e.button() != 0 {
            return;
        }
        let Some(t) = e
            .target()
            .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
        else {
            return;
        };
        if t.closest(".lex-pop, .lex-edge-hit")
            .ok()
            .flatten()
            .is_some()
        {
            return;
        }
        let (x0, y0) = local(&e);
        let id = t
            .closest(".lex-node")
            .ok()
            .flatten()
            .and_then(|n| n.get_attribute("data-id"));
        drag.set_value(Some(match id {
            Some(id) => Drag::Node {
                id,
                x0,
                y0,
                moved: false,
            },
            None => Drag::Pan {
                x0,
                y0,
                from: g.cam.get_untracked(),
                moved: false,
            },
        }));
    };
    let on_move = move |e: web_sys::PointerEvent| {
        let (x, y) = local(&e);
        let (w, h) = g.size.get_untracked();
        // Capture only once it is a drag: capturing on press would steal a node's click.
        let mut started = false;
        let mut target = None;
        drag.update_value(|d| match d {
            Some(Drag::Node { id, x0, y0, moved }) => {
                if !*moved && (x - *x0).hypot(y - *y0) < DRAG_SLOP {
                    return;
                }
                started = !*moved;
                *moved = true;
                target = Some(id.clone());
            }
            Some(Drag::Pan {
                x0,
                y0,
                from,
                moved,
            }) => {
                if !*moved && (x - *x0).hypot(y - *y0) < DRAG_SLOP {
                    return;
                }
                started = !*moved;
                *moved = true;
                g.cam.set(Cam {
                    cx: from.cx - (x - *x0) / from.k,
                    cy: from.cy - (y - *y0) / from.k,
                    k: from.k,
                });
            }
            None => {}
        });
        if started {
            capture(&e);
            g.fit.set(false);
            g.stop_glide();
        }
        if let Some(i) = target.and_then(|id| g.index(&id)) {
            let (ux, uy) = g.cam.get_untracked().to_layout(x, y, w, h);
            g.sim.update_value(|s| {
                if started {
                    s.hold_warm(true);
                }
                s.drag_to(i, ux, uy);
            });
            g.kick();
        }
    };
    let on_up = move |_| match drag.try_update_value(Option::take).flatten() {
        Some(Drag::Node {
            id, moved: true, ..
        }) => {
            if let Some(i) = g.index(&id) {
                g.sim.update_value(|s| {
                    s.release(i);
                    s.hold_warm(false);
                });
                g.kick();
            }
        }
        // A press on the empty stage that never moved: put the popover away.
        Some(Drag::Pan { moved: false, .. }) => selected.set(None),
        _ => {}
    };
    let on_wheel = move |e: web_sys::WheelEvent| {
        e.prevent_default();
        let (x, y) = local(&e);
        let (w, h) = g.size.get_untracked();
        g.fit.set(false);
        g.stop_glide();
        if e.ctrl_key() {
            // A trackpad pinch arrives as a ctrl-wheel.
            let f = (-e.delta_y() * 0.01).exp();
            g.cam.update(|c| *c = c.zoom_at(f, x, y, w, h));
        } else {
            g.cam.update(|c| {
                c.cx += e.delta_x() / c.k;
                c.cy += e.delta_y() / c.k;
            });
        }
    };

    let open = move |sel: Sel, from: Option<web_sys::HtmlElement>| {
        opener.set_value(from);
        selected.set(Some(sel));
    };

    // Find links
    let busy = RwSignal::new(false);
    let status = RwSignal::new(String::new());
    let new_count = Memo::new(move |_| lexicon.with(|l| unlinked(l).len()));
    let can_link =
        move || lexicon.with(|l| l.terms.len() >= 2) && new_count.get() > 0 && !busy.get();
    let find_links = move |_| {
        busy.set(true);
        status.set("Reading your terms…".into());
        leptos::task::spawn_local(async move {
            let message = link_once().await;
            busy.try_set(false);
            status.try_set(message);
        });
    };

    let fit_now = move |_| {
        g.stop_glide();
        g.fit.set(true);
        g.refit();
    };

    view! {
        <div id="root" class="lex">
            <header class="lex-masthead">
                <a class="lex-back" href=chrome::get_url(PAPERS_PAGE_PATH)>"← Papers"</a>
                <h1>"Lexicon"</h1>
                <div class="lex-tools">
                    <span class="lex-count">{move || lexicon.with(|l| {
                        let (t, e) = (l.terms.len(), l.edges.len());
                        format!("{t} term{} · {e} link{}", if t == 1 { "" } else { "s" }, if e == 1 { "" } else { "s" })
                    })}</span>
                    <button type="button" class="ai-note-btn" on:click=fit_now disabled=move || g.fit.get()>"Fit"</button>
                    <button
                        type="button"
                        class="fc-primary-btn"
                        on:click=find_links
                        disabled=move || !can_link()
                        title=move || if lexicon.with(|l| l.terms.len() < 2) { "Keep one more term to find links" } else { "" }
                    >
                        {move || match (busy.get(), new_count.get(), lexicon.with(|l| l.terms.len() < 2)) {
                            (true, ..) => "Finding links…".to_string(),
                            (_, _, true) => "Find links".to_string(),
                            (_, 0, _) => "All linked".to_string(),
                            (_, n, _) => format!("Find links ({n} new)"),
                        }}
                    </button>
                </div>
            </header>
            <p class="lex-status" role="status">{move || status.get()}</p>
            <div
                node_ref=stage
                class="lex-stage"
                on:pointerdown=on_down
                on:pointermove=on_move
                on:pointerup=on_up
                on:pointercancel=on_up
                on:wheel=on_wheel
            >
                <Show when=move || loaded.get() && lexicon.with(|l| l.terms.is_empty())>
                    <div class="lex-empty">
                        <p class="lex-empty-title">"Your lexicon is empty"</p>
                        <p>"Click a term while reading, then keep it with Add to lexicon."</p>
                    </div>
                </Show>
                <svg class="lex-edges" aria-hidden="true">
                    <For each=move || lexicon.get().edges key=|e| (e.a.clone(), e.b.clone()) let:edge>
                        <EdgeLine a=edge.a b=edge.b g=g hovered=hovered selected=selected lexicon=lexicon on_open=Callback::new(move |s| open(s, None)) />
                    </For>
                </svg>
                <For each=move || lexicon.get().terms key=|t| t.id.clone() let:term>
                    <Node
                        id=term.id
                        label=term.label
                        fresh=term.linked_at.is_none()
                        g=g
                        hovered=hovered
                        selected=selected
                        lexicon=lexicon
                        on_open=Callback::new(move |(s, el)| open(s, Some(el)))
                    />
                </For>
                {move || selected.get().map(|s| match s {
                    Sel::Term(id) => view! {
                        <TermPop id=id g=g lexicon=lexicon
                            on_close=Callback::new(move |_| close())
                            on_pick=Callback::new(move |other: String| {
                                g.glide_to(&other);
                                selected.set(Some(Sel::Term(other)));
                            })
                        />
                    }.into_any(),
                    Sel::Edge(a, b) => view! {
                        <EdgePop a=a b=b g=g lexicon=lexicon
                            on_close=Callback::new(move |_| close())
                            on_pick=Callback::new(move |other: String| {
                                g.glide_to(&other);
                                selected.set(Some(Sel::Term(other)));
                            })
                        />
                    }.into_any(),
                })}
            </div>
        </div>
    }
}

/// One "Find links" press: ask Haiku, then merge what it found into the
/// lexicon as it is when the answer lands (a term deleted meanwhile gets no
/// edge). Returns the line to show.
async fn link_once() -> String {
    let lex: Lexicon = store::get("lexicon").await.unwrap_or_default();
    let Some(request) = link_request(&lex) else {
        return String::new();
    };
    let sent: Vec<String> = unlinked(&lex).iter().map(|t| t.id.clone()).collect();
    let settings = store::settings().await.unwrap_or_default();
    let model = match route(
        window().navigator().on_line(),
        !settings.claude_key.is_empty(),
    ) {
        Route::None { reason } => return format!("{reason}."),
        Route::Claude { model, .. } => model,
    };
    let reply = claude::stream(
        claude::Ask {
            api_key: &settings.claude_key,
            model,
            system: &request.system,
            document: &request.passages.join("\n\n"),
            prompt: &request.prompt,
            cache: false,
            timeout_ms: LINK_TIMEOUT_MS,
            controller: None,
            image_jpeg: None,
            remember: false,
        },
        |_| {},
    )
    .await;
    let text = match reply {
        Ok(t) => t,
        Err(e) => return e,
    };
    let mut now_lex: Lexicon = store::get("lexicon").await.unwrap_or_default();
    match parse_links(&text, &now_lex, now()) {
        Err(e) => e,
        Ok(edges) => {
            let added = merge_links(&mut now_lex, edges, &sent, now());
            let _ = store::set("lexicon", &now_lex).await;
            match added {
                0 => "No new links this time.".into(),
                1 => "Found 1 new link.".into(),
                n => format!("Found {n} new links."),
            }
        }
    }
}

#[component]
fn Node(
    id: String,
    label: String,
    fresh: bool,
    g: Graph,
    hovered: RwSignal<Option<String>>,
    selected: RwSignal<Option<Sel>>,
    lexicon: Signal<Lexicon>,
    on_open: Callback<(Sel, web_sys::HtmlElement)>,
) -> impl IntoView {
    let id = StoredValue::new(id);
    // Placed once here; every later move is paint()'s.
    let style = id
        .with_value(|id| {
            let (w, h) = g.size.get_untracked();
            let cam = g.cam.get_untracked();
            g.pos
                .with_untracked(|m| m.get(id).map(|&(x, y)| cam.to_screen(x, y, w, h)))
        })
        .map(|(x, y)| format!("transform: {};", node_transform(x, y)))
        .unwrap_or_default();
    let degree = Memo::new(move |_| {
        id.with_value(|id| lexicon.with(|l| l.edges.iter().filter(|e| e.touches(id)).count()))
    });
    let size = move || format!("{}px", 12 + 3 * degree.get().min(6));
    let dim = move || {
        hovered.with(|h| {
            h.as_ref().is_some_and(|h| {
                id.with_value(|id| {
                    h != id && !lexicon.with(|l| l.edges.iter().any(|e| e.joins(h, id)))
                })
            })
        })
    };
    let is_open =
        move || selected.with(|s| matches!(s, Some(Sel::Term(t)) if id.with_value(|id| t == id)));
    let aria = {
        let label = label.clone();
        move || {
            let n = degree.get();
            format!("{label}, {n} link{}", if n == 1 { "" } else { "s" })
        }
    };
    let enter = move || hovered.set(Some(id.get_value()));
    let leave = move || {
        hovered.update(|h| {
            if h.as_deref() == Some(id.get_value().as_str()) {
                *h = None;
            }
        })
    };
    view! {
        <button
            type="button"
            class="lex-node"
            class:is-dim=dim
            class:is-open=is_open
            class:is-fresh=fresh
            data-id=id.get_value()
            style=style
            style:width=size
            style:height=size
            aria-label=aria
            aria-haspopup="dialog"
            aria-expanded=move || is_open().to_string()
            on:click=move |e| {
                let el = e.current_target().and_then(|t| t.dyn_into::<web_sys::HtmlElement>().ok());
                if let Some(el) = el {
                    on_open.run((Sel::Term(id.get_value()), el));
                }
            }
            on:pointerenter=move |_| enter()
            on:pointerleave=move |_| leave()
            on:focus=move |_| enter()
            on:blur=move |_| leave()
        >
            <span class="lex-dot"></span>
            <span class="lex-label">{label}</span>
        </button>
    }
}

#[component]
fn EdgeLine(
    a: String,
    b: String,
    g: Graph,
    hovered: RwSignal<Option<String>>,
    selected: RwSignal<Option<Sel>>,
    lexicon: Signal<Lexicon>,
    on_open: Callback<Sel>,
) -> impl IntoView {
    let ends = StoredValue::new((a.clone(), b.clone()));
    // Placed once here; every later move is paint()'s.
    let ((x1, y1), (x2, y2)) = {
        let (w, h) = g.size.get_untracked();
        let cam = g.cam.get_untracked();
        g.pos
            .with_untracked(|m| m.get(&a).zip(m.get(&b)).map(|(&p, &q)| (p, q)))
            .map(|((ax, ay), (bx, by))| (cam.to_screen(ax, ay, w, h), cam.to_screen(bx, by, w, h)))
            .unwrap_or_default()
    };
    let dim = move || {
        hovered.with(|h| {
            h.as_ref()
                .is_some_and(|h| ends.with_value(|(a, b)| h != a && h != b))
        })
    };
    let lit = move || {
        hovered.with(|h| {
            h.as_ref()
                .is_some_and(|h| ends.with_value(|(a, b)| h == a || h == b))
        }) || selected.with(
            |s| matches!(s, Some(Sel::Edge(x, y)) if ends.with_value(|(a, b)| x == a && y == b)),
        )
    };
    let title = move || {
        ends.with_value(|(a, b)| {
            lexicon.with(|l| {
                let rel = l
                    .edges
                    .iter()
                    .find(|e| e.joins(a, b))
                    .map(|e| e.relation.clone())
                    .unwrap_or_default();
                format!("{} {rel} {}", label_of(l, a), label_of(l, b))
            })
        })
    };
    view! {
        <g class="lex-edge" class:is-dim=dim class:is-lit=lit>
            <line class="lex-edge-line" data-a=a.clone() data-b=b.clone() x1=x1 y1=y1 x2=x2 y2=y2 />
            <line
                class="lex-edge-hit"
                data-a=a
                data-b=b
                x1=x1 y1=y1 x2=x2 y2=y2
                on:click=move |_| ends.with_value(|(a, b)| on_open.run(Sel::Edge(a.clone(), b.clone())))
            >
                <title>{title}</title>
            </line>
        </g>
    }
}

#[component]
fn TermPop(
    id: String,
    g: Graph,
    lexicon: Signal<Lexicon>,
    on_close: Callback<()>,
    on_pick: Callback<String>,
) -> impl IntoView {
    let id = StoredValue::new(id);
    let confirming = RwSignal::new(false);
    let term = Memo::new(move |_| {
        id.with_value(|id| lexicon.with(|l| l.terms.iter().find(|t| t.id == *id).cloned()))
    });
    // The term was deleted (here or in another tab): nothing left to show.
    Effect::new(move |_| {
        if term.with(Option::is_none) {
            on_close.run(());
        }
    });
    let links = Memo::new(move |_| {
        id.with_value(|id| {
            lexicon.with(|l| {
                l.edges
                    .iter()
                    .filter(|e| e.touches(id))
                    .map(|e| {
                        let outgoing = e.a == *id;
                        let other = if outgoing { &e.b } else { &e.a };
                        (
                            other.clone(),
                            label_of(l, other),
                            e.relation.clone(),
                            outgoing,
                        )
                    })
                    .collect::<Vec<_>>()
            })
        })
    });
    let style = move || {
        id.with_value(|id| g.screen(id))
            .map(|(x, y)| pop_style(x, y, g.size.get()))
            .unwrap_or_default()
    };
    let delete = move |_| {
        let gone = id.get_value();
        leptos::task::spawn_local(async move { edit(move |l| remove_term(l, &gone)).await });
        on_close.run(());
    };
    let label = move || term.with(|t| t.as_ref().map(|t| t.label.clone()).unwrap_or_default());
    view! {
        <div class="lex-pop" role="dialog" aria-label=move || format!("{}: meaning and links", label()) style=style>
            <div class="lex-pop-head">
                <h2 class="lex-pop-title">{label}</h2>
                <button type="button" class="ai-note-link" aria-label="Close" on:click=move |_| on_close.run(())>"×"</button>
            </div>
            {move || term.get().map(|t| view! { <TermSources sources=t.sources /> })}
            <Show when=move || links.with(|l| !l.is_empty())>
                <p class="lex-links-label">"Links"</p>
                <ul class="lex-links">
                    {move || links.get().into_iter().map(|(other, name, relation, outgoing)| view! {
                        <li>
                            <button type="button" class="lex-chip" on:click=move |_| on_pick.run(other.clone())>
                                <span class="lex-rel">{if outgoing { format!("{relation} →") } else { format!("← {relation}") }}</span>
                                " "{name}
                            </button>
                        </li>
                    }).collect_view()}
                </ul>
            </Show>
            <div class="lex-pop-foot">
                {move || if confirming.get() {
                    view! {
                        <span class="lex-confirm">
                            "Delete this term and its links?"
                            <button type="button" class="ai-note-link is-danger" on:click=delete>"Delete"</button>
                            <button type="button" class="ai-note-link" on:click=move |_| confirming.set(false)>"Keep"</button>
                        </span>
                    }.into_any()
                } else {
                    view! { <button type="button" class="ai-note-link is-quiet" on:click=move |_| confirming.set(true)>"Delete term"</button> }.into_any()
                }}
            </div>
        </div>
    }
}

#[component]
pub fn TermSources(sources: Vec<Source>) -> impl IntoView {
    let (papers, _) = use_storage::<Vec<Paper>>("papers");
    sources.into_iter().map(|s| {
        let source = s.clone();
        let href = Memo::new(move |_| papers.with(|p| source_reader_path(&source, p)));
        let guess = s.guess;
        let context = s.context;
        view! {
            <section class="lex-source">
                <p class="lex-paper">{s.paper_title}</p>
                <Markdown text=Signal::derive(move || s.definition.clone()) />
                {(!context.is_empty()).then(|| view! { <blockquote class="lex-context">{context}</blockquote> })}
                {(!guess.is_empty()).then(|| view! { <p class="lex-guess">"Your guess: "{guess}</p> })}
                {move || href.get().map(|path| view! {
                    <a class="ai-note-link" href=chrome::get_url(&path) target="_blank" rel="noopener">"Open paper ↗"</a>
                })}
            </section>
        }
    }).collect_view()
}

#[component]
fn EdgePop(
    a: String,
    b: String,
    g: Graph,
    lexicon: Signal<Lexicon>,
    on_close: Callback<()>,
    on_pick: Callback<String>,
) -> impl IntoView {
    let ends = StoredValue::new((a, b));
    let edge = Memo::new(move |_| {
        ends.with_value(|(a, b)| lexicon.with(|l| l.edges.iter().find(|e| e.joins(a, b)).cloned()))
    });
    Effect::new(move |_| {
        if edge.with(Option::is_none) {
            on_close.run(());
        }
    });
    let style = move || {
        ends.with_value(|(a, b)| g.screen(a).zip(g.screen(b)))
            .map(|((x1, y1), (x2, y2))| pop_style((x1 + x2) / 2.0, (y1 + y2) / 2.0, g.size.get()))
            .unwrap_or_default()
    };
    let name = move |id: &str| lexicon.with(|l| label_of(l, id));
    let delete = move |_| {
        let (a, b) = ends.get_value();
        leptos::task::spawn_local(async move { edit(move |l| remove_edge(l, &a, &b)).await });
        on_close.run(());
    };
    view! {
        <div class="lex-pop lex-pop--edge" role="dialog" aria-label="Link" style=style>
            {move || edge.get().map(|e| {
                let (a, b) = (e.a.clone(), e.b.clone());
                view! {
                    <p class="lex-edge-phrase">
                        <button type="button" class="lex-chip" on:click=move |_| on_pick.run(a.clone())>{name(&e.a)}</button>
                        <span class="lex-rel">{e.relation.clone()}</span>
                        <button type="button" class="lex-chip" on:click=move |_| on_pick.run(b.clone())>{name(&e.b)}</button>
                    </p>
                    <p class="lex-why">{e.why.clone()}</p>
                }
            })}
            <div class="lex-pop-foot">
                <button type="button" class="ai-note-link is-quiet" on:click=delete>"Remove link"</button>
                <button type="button" class="ai-note-link" on:click=move |_| on_close.run(())>"Close"</button>
            </div>
        </div>
    }
}

//! Dragging a to-do within and between the board's columns, the way iOS does
//! it: the card lifts under the pointer, the others slide apart to show where
//! it will land, and on release it springs into that gap. During the drag
//! everything is direct DOM (the `translate` property only, so the springs in
//! newtab.css do the motion); the drop is one state change.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use wasm_bindgen::{prelude::*, JsCast};
use web_sys::{Element, HtmlElement, PointerEvent};

/// How far the pointer travels before a press becomes a drag (a click stays a click).
const SLOP: f64 = 5.0;
/// `.board-list`'s row gap (--space-2).
const GAP: f64 = 8.0;

struct Drag {
    id: String,
    el: HtmlElement,
    from: (usize, usize),
    x0: f64,
    y0: f64,
    ghost: Option<HtmlElement>,
    slot: f64,
    target: (usize, usize),
    on_drop: Rc<dyn Fn(String, usize, usize)>,
}

thread_local! {
    static DRAG: RefCell<Option<Drag>> = const { RefCell::new(None) };
    static LISTENING: Cell<bool> = const { Cell::new(false) };
}

/// Move, release and cancel are heard on the window, not the card: pointer
/// capture is lost when the card re-renders or the window loses focus, and a
/// release that never arrives would leave the card hanging in mid-air.
fn listen() {
    if LISTENING.with(|l| l.replace(true)) {
        return;
    }
    let w = leptos::prelude::window();
    let on = |name: &str, f: Box<dyn FnMut(web_sys::Event)>| {
        let f = Closure::<dyn FnMut(web_sys::Event)>::new(f);
        let _ = w.add_event_listener_with_callback(name, f.as_ref().unchecked_ref());
        f.forget(); // the page lives as long as its listeners
    };
    on("pointermove", Box::new(|e| moved(e.unchecked_ref())));
    on("pointerup", Box::new(|e| up(e.unchecked_ref())));
    on("pointercancel", Box::new(|_| cancel()));
    on("blur", Box::new(|_| cancel()));
    on(
        "keydown",
        Box::new(|e| {
            if e.unchecked_ref::<web_sys::KeyboardEvent>().key() == "Escape" {
                cancel();
            }
        }),
    );
}

fn doc() -> web_sys::Document {
    leptos::prelude::document()
}

fn all(root: &Element, selector: &str) -> Vec<HtmlElement> {
    let Ok(nodes) = root.query_selector_all(selector) else {
        return vec![];
    };
    (0..nodes.length())
        .filter_map(|i| nodes.item(i)?.dyn_into().ok())
        .collect()
}

/// The three lists, To do first.
fn lists() -> Vec<HtmlElement> {
    doc()
        .document_element()
        .map(|r| all(&r, ".board--todos .board-list"))
        .unwrap_or_default()
}

fn cards(list: &HtmlElement) -> Vec<HtmlElement> {
    all(list, ":scope > li.todo")
}

fn set_translate(el: &HtmlElement, value: &str) {
    let _ = el.style().set_property("translate", value);
}

pub fn down(e: &PointerEvent, id: String, col: usize, on_drop: Rc<dyn Fn(String, usize, usize)>) {
    if e.button() != 0 {
        return;
    }
    cancel(); // a drag left over from anything odd never outlives the next press
    listen();
    // The card's own controls keep working.
    let on_control = e
        .target()
        .and_then(|t| t.dyn_into::<Element>().ok())
        .and_then(|t| {
            t.closest("button, input, a, select, textarea")
                .ok()
                .flatten()
        })
        .is_some();
    let Some(el) = e
        .current_target()
        .and_then(|t| t.dyn_into::<HtmlElement>().ok())
    else {
        return;
    };
    if on_control {
        return;
    }
    let idx = lists()
        .get(col)
        .map(|l| cards(l).iter().position(|c| *c == el).unwrap_or(0))
        .unwrap_or(0);
    DRAG.with(|d| {
        *d.borrow_mut() = Some(Drag {
            id,
            el,
            from: (col, idx),
            x0: e.client_x() as f64,
            y0: e.client_y() as f64,
            ghost: None,
            slot: 0.0,
            target: (col, idx),
            on_drop,
        })
    });
}

/// The card leaves its slot: a copy floats under the pointer, the original
/// stays in place, invisible, so nothing jumps.
fn lift(d: &mut Drag) {
    let rect = d.el.get_bounding_client_rect();
    let Ok(ghost) =
        d.el.clone_node_with_deep(true)
            .map(|n| n.unchecked_into::<HtmlElement>())
    else {
        return;
    };
    let _ = ghost.class_list().add_1("todo--ghost");
    let _ = ghost.remove_attribute("data-todo-id");
    let s = ghost.style();
    for (k, v) in [
        ("left", format!("{}px", rect.left())),
        ("top", format!("{}px", rect.top())),
        ("width", format!("{}px", rect.width())),
        ("height", format!("{}px", rect.height())),
    ] {
        let _ = s.set_property(k, &v);
    }
    if let Some(body) = doc().body() {
        let _ = body.append_child(&ghost);
        let _ = body.class_list().add_1("todo-dragging");
    }
    // Commit the resting frame, then lift: the scale and shadow spring in.
    let _ = ghost.get_bounding_client_rect();
    let _ = ghost.class_list().add_1("todo--lifted");
    let _ = d.el.class_list().add_1("todo--placeholder");
    d.slot = rect.height() + GAP;
    d.ghost = Some(ghost);
}

/// Which column the pointer is over (by the column card), and where among
/// its other cards it would land, judged against their resting positions.
/// Anywhere else is "put it back": the card returns to where it came from.
fn locate(d: &Drag, x: f64, y: f64) -> (usize, usize) {
    let lists = lists();
    let Some(col) = lists.iter().position(|l| {
        let r = l
            .parent_element()
            .map(|p| p.get_bounding_client_rect())
            .unwrap_or_else(|| l.get_bounding_client_rect());
        y >= r.top() && y <= r.bottom() && x >= r.left() && x <= r.right()
    }) else {
        return d.from;
    };
    let Some(list) = lists.get(col) else {
        return d.target;
    };
    let top = list.get_bounding_client_rect().top() - list.scroll_top() as f64;
    let idx = cards(list)
        .iter()
        .enumerate()
        .filter(|(_, c)| **c != d.el)
        .filter(|(k, c)| {
            // The cards below the hidden original sit one slot lower than they will.
            let lift = if col == d.from.0 && *k > d.from.1 {
                d.slot
            } else {
                0.0
            };
            top + c.offset_top() as f64 - lift + c.offset_height() as f64 / 2.0 < y
        })
        .count();
    (col, idx)
}

/// Slide every other card to where it will be if the drop happened now.
fn make_room(d: &Drag) {
    let (tc, ti) = d.target;
    for (c, list) in lists().iter().enumerate() {
        if let Some(col) = list.parent_element() {
            let _ = col
                .class_list()
                .toggle_with_force("board-col--over", c == tc);
        }
        for (k, card) in cards(list).iter().enumerate().filter(|(_, c)| **c != d.el) {
            let k2 = if c == d.from.0 && k > d.from.1 {
                k - 1
            } else {
                k
            };
            let wanted = k2 + usize::from(c == tc && k2 >= ti);
            let delta = wanted as f64 - k as f64;
            set_translate(
                card,
                &if delta == 0.0 {
                    String::new()
                } else {
                    format!("0 {}px", delta * d.slot)
                },
            );
        }
    }
}

fn moved(e: &PointerEvent) {
    DRAG.with(|cell| {
        let mut cell = cell.borrow_mut();
        let Some(d) = cell.as_mut() else { return };
        let (dx, dy) = (e.client_x() as f64 - d.x0, e.client_y() as f64 - d.y0);
        if d.ghost.is_none() {
            if dx.hypot(dy) < SLOP {
                return;
            }
            lift(d);
            make_room(d);
        }
        if let Some(g) = &d.ghost {
            set_translate(g, &format!("{dx}px {dy}px"));
        }
        let target = locate(d, e.client_x() as f64, e.client_y() as f64);
        if target != d.target {
            d.target = target;
            make_room(d);
        }
    });
}

fn clear(d: &Drag) {
    for list in lists() {
        if let Some(col) = list.parent_element() {
            let _ = col.class_list().remove_1("board-col--over");
        }
        for card in cards(&list) {
            set_translate(&card, "");
        }
    }
    let _ = d.el.class_list().remove_1("todo--placeholder");
    if let Some(body) = doc().body() {
        let _ = body.class_list().remove_1("todo-dragging");
    }
}

/// Release: the state changes at once (`on_drop`), and the card, now in its
/// new place, starts where the floating copy was and springs into the slot.
fn up(_: &PointerEvent) {
    let Some(d) = DRAG.with(|c| c.borrow_mut().take()) else {
        return;
    };
    let Some(ghost) = d.ghost.clone() else { return };
    let from = ghost.get_bounding_client_rect();
    let id = d.id.clone();
    (d.on_drop)(d.id.clone(), d.target.0, d.target.1);
    // After the list re-renders (a microtask), before the next paint.
    let land = Closure::once_into_js(move || {
        clear(&d);
        ghost.remove();
        let Ok(Some(el)) = doc().query_selector(&format!("[data-todo-id=\"{id}\"]")) else {
            return;
        };
        let el: HtmlElement = el.unchecked_into();
        let to = el.get_bounding_client_rect();
        let s = el.style();
        let _ = s.set_property("transition", "none");
        set_translate(
            &el,
            &format!("{}px {}px", from.left() - to.left(), from.top() - to.top()),
        );
        let _ = el.class_list().add_1("todo--lifted");
        let _ = el.get_bounding_client_rect();
        let _ = s.remove_property("transition");
        set_translate(&el, "");
        let _ = el.class_list().remove_1("todo--lifted");
    });
    let _ = leptos::prelude::window().request_animation_frame(land.unchecked_ref());
}

pub fn cancel() {
    if let Some(d) = DRAG.with(|c| c.borrow_mut().take()) {
        clear(&d);
        if let Some(g) = d.ghost {
            g.remove();
        }
    }
}

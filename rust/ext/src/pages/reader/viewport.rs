//! The scrolling page list.
//! Every page gets a fixed-size placeholder up front (sizes are known before
//! any rendering), so scroll geometry is exact; IntersectionObservers fill in
//! canvases near the viewport and drop far-away ones to bound memory.

use crate::pdfjs::{self, PageSize};
use leptos::html;
use leptos::prelude::*;
use reader_core::figures::{split_mentions, Segment};
use reader_core::pdf::{position_from_scroll, PdfPosition};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

/// Vertical gap between pages, and padding above the first / below the last.
pub const PAGE_GAP: f64 = 16.0;
/// Pages within this margin get (and keep) a rendered canvas.
const RENDER_MARGIN: &str = "1500px 0px";
/// A wider margin gets a cheap 1x thumbnail, so a fast flick shows a soft page, not a blank one.
const THUMB_MARGIN: &str = "6000px 0px";
const THUMB_SCALE: f64 = 0.3;
/// Side breathing room around the widest page at fit-width (zoom 1).
const PAGE_INSET: f64 = 48.0;
/// Canvases re-render this long after the last zoom step; CSS stretches the old bitmap until then.
const RERENDER_DELAY_MS: u64 = 150;
/// A pinch counts as over once no zoom step has arrived for this long.
const PINCH_SETTLE_MS: i32 = 150;
pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 3.0;

/// Navigation glides; restore and zoom re-anchoring never do.
pub(super) fn nav_smooth() -> bool {
    !crate::pages::reduced_motion()
}

/// A request to scroll: (page, offset, sequence) so the same target twice still moves.
pub type Jump = (u32, f64, u64);

#[derive(Clone, Copy, PartialEq)]
struct Geometry {
    scale: f64,
    list_width: f64,
}

#[derive(Clone, Copy)]
struct ZoomAnchor {
    x: f64,
    y: f64,
    page: u32,
    offset: f64,
    from_center: f64,
}

#[component]
pub fn PdfViewport(
    doc: StoredValue<JsValue, LocalStorage>,
    sizes: Signal<Vec<PageSize>>,
    zoom: RwSignal<f64>,
    initial: Option<(u32, f64)>,
    on_restored: Callback<()>,
    on_position: Callback<PdfPosition>,
    jump: ReadSignal<Option<Jump>>,
    figures: ReadSignal<HashMap<String, PdfPosition>>,
    /// Clicked text that is not a link or a figure (click-to-define, in 4b)
    #[prop(optional)]
    on_text_click: Option<Callback<web_sys::MouseEvent>>,
    /// Extra layers per page (annotations), given the page number
    #[prop(optional, into)]
    page_extra: Option<Callback<u32, AnyView>>,
    /// Any scroll (a waiting selection menu or definition goes with it)
    #[prop(optional)]
    on_scroll: Option<Callback<()>>,
) -> impl IntoView {
    let container: NodeRef<html::Div> = NodeRef::new();
    let list: NodeRef<html::Div> = NodeRef::new();
    let width = RwSignal::new(0.0);

    // Measure the container now and on every resize.
    Effect::new(move |_| {
        let Some(el) = container.get() else { return };
        width.set(f64::from(el.client_width()));
        // Arrow keys and Space scroll the document from the first moment. That
        // load-time focus is not a selection, so it draws no ring until focus moves.
        let _ = el.dataset().set("autofocused", "");
        let blurred = Closure::once_into_js({
            let el = el.clone();
            move || {
                el.dataset().delete("autofocused");
            }
        });
        let opts = web_sys::AddEventListenerOptions::new();
        opts.set_once(true);
        let _ = el.add_event_listener_with_callback_and_add_event_listener_options(
            "blur",
            blurred.unchecked_ref(),
            &opts,
        );
        let opts = web_sys::FocusOptions::new();
        opts.set_prevent_scroll(true);
        let _ = el.focus_with_options(&opts);
        let observed = el.clone();
        let cb = Closure::<dyn FnMut()>::new(move || width.set(f64::from(observed.client_width())));
        if let Ok(ro) = web_sys::ResizeObserver::new(cb.as_ref().unchecked_ref()) {
            ro.observe(&el);
            on_cleanup(move || ro.disconnect());
        }
        cb.forget();
    });

    let max_width =
        Memo::new(move |_| sizes.with(|s| s.iter().map(|p| p.width).fold(1.0, f64::max)));
    let geometry = Memo::new(move |_| {
        let w = width.get();
        let scale = if w > 0.0 {
            (w - PAGE_INSET) / max_width.get() * zoom.get()
        } else {
            0.0
        };
        // Wider than the viewport once zoomed in, so the whole page can be scrolled to.
        Geometry {
            scale,
            list_width: w.max(max_width.get() * scale + PAGE_INSET),
        }
    });
    let scale = Memo::new(move |_| geometry.get().scale);
    let layout = Memo::new(move |_| {
        let s = scale.get();
        let mut tops = Vec::new();
        let mut heights = Vec::new();
        let mut y = PAGE_GAP;
        for size in sizes.get() {
            tops.push(y);
            heights.push(size.height * s);
            y += size.height * s + PAGE_GAP;
        }
        (tops, heights, y)
    });

    // Canvases render at a scale that trails the live one, so a pinch stretches
    // what is painted instead of re-rasterising per frame.
    let render_scale = RwSignal::new(0.0);
    let pending: StoredValue<Option<TimeoutHandle>, LocalStorage> = StoredValue::new_local(None);
    Effect::new(move |_| {
        let s = scale.get();
        if let Some(h) = pending.try_update_value(Option::take).flatten() {
            h.clear();
        }
        if render_scale.get_untracked() == 0.0 {
            render_scale.set(s);
            return;
        }
        let h = set_timeout_with_handle(
            move || render_scale.set(s),
            std::time::Duration::from_millis(RERENDER_DELAY_MS),
        )
        .ok();
        pending.set_value(h);
    });

    let last_pos: StoredValue<(u32, f64), LocalStorage> = StoredValue::new_local((1, 0.0));
    let scroll_to = move |page: u32, offset: f64, smooth: bool, anchor_y: Option<f64>| {
        let Some(el) = container.get_untracked() else {
            return;
        };
        let (tops, heights, _) = layout.get_untracked();
        if tops.is_empty() {
            return;
        }
        let i = (page.max(1) as usize).min(tops.len()) - 1;
        let target = (tops[i] + offset * heights[i]
            - anchor_y.unwrap_or(f64::from(el.client_height()) / 2.0))
        .max(0.0);
        // Chrome's glide lengthens with distance; cut to one screen short and glide the rest.
        let distance = target - f64::from(el.scroll_top());
        if smooth && distance.abs() > f64::from(el.client_height()) {
            el.set_scroll_top((target - distance.signum() * f64::from(el.client_height())) as i32);
        }
        let opts = web_sys::ScrollToOptions::new();
        opts.set_top(target);
        opts.set_behavior(if smooth {
            web_sys::ScrollBehavior::Smooth
        } else {
            web_sys::ScrollBehavior::Instant
        });
        el.scroll_to_with_scroll_to_options(&opts);
        // Remember what is now mid-view, not what was asked for: a later
        // re-layout re-centres on it, and a page top asked to sit at the top
        // would otherwise drift down to the middle.
        let mid = target + f64::from(el.client_height()) / 2.0;
        let j = tops.iter().rposition(|t| *t <= mid).unwrap_or(0);
        let at = ((mid - tops[j]) / heights[j].max(1.0)).clamp(0.0, 1.0);
        last_pos.set_value((j as u32 + 1, at));
    };

    // A page jump (offset 0) puts the page top at the top; a spot inside a page lands mid-view.
    Effect::new(move |_| {
        if let Some((page, offset, _)) = jump.get() {
            scroll_to(
                page,
                offset,
                nav_smooth(),
                (offset == 0.0).then_some(PAGE_GAP),
            );
        }
    });

    // The saved position needs real layout, so the restore lives here and runs once.
    let restored = StoredValue::new(false);
    Effect::new(move |_| {
        // Wait for the page sizes too: with no layout there is nothing to scroll to.
        let (tops, _, height) = layout.get();
        if scale.get() <= 0.0 || tops.is_empty() || restored.get_value() {
            return;
        }
        restored.set_value(true);
        // The reactive `style:height` may not have landed yet, and the browser
        // would clamp the scroll to the old (empty) list. Size it now.
        if let Some(l) = list.get_untracked() {
            let _ = web_sys::HtmlElement::style(&l).set_property("height", &format!("{height}px"));
        }
        if let Some((page, offset)) = initial {
            // As with a jump: the start of a page (a #page=N link) lands at the top.
            scroll_to(page, offset, false, (offset == 0.0).then_some(PAGE_GAP));
        }
        on_restored.run(());
    });

    // Zoom keeps the reading position: a pinch anchors on the point under the
    // cursor, the toolbar on the middle.
    let zoom_anchor: StoredValue<Option<ZoomAnchor>, LocalStorage> = StoredValue::new_local(None);
    let prev_scale = StoredValue::new(0.0f64);
    Effect::new(move |_| {
        let g = geometry.get();
        let prev = prev_scale.get_value();
        if g.scale > 0.0 && prev > 0.0 && prev != g.scale {
            if let Some(l) = list.get_untracked() {
                let style = web_sys::HtmlElement::style(&l);
                let _ = style.remove_property("transform");
                // This effect can run before the reactive `style:width/height` update lands,
                // and the browser would clamp the scroll to the old size. Apply the new size now.
                let _ = style.set_property("width", &format!("{}px", g.list_width));
                let _ = style.set_property("height", &format!("{}px", layout.get_untracked().2));
            }
            match zoom_anchor.try_update_value(Option::take).flatten() {
                Some(a) => {
                    scroll_to(a.page, a.offset, false, Some(a.y));
                    if let Some(el) = container.get_untracked() {
                        el.set_scroll_left(
                            (g.list_width / 2.0 + a.from_center * g.scale - a.x) as i32,
                        );
                    }
                }
                None => {
                    let (page, offset) = last_pos.get_value();
                    scroll_to(page, offset, false, None);
                }
            }
        }
        prev_scale.set_value(g.scale);
    });

    // Trackpad pinch arrives as ctrl+wheel; ⌘+wheel is the mouse equivalent. A
    // native listener: Leptos's (like React's) wheel handler is passive and
    // can't stop browser zoom. The pinch only stretches what is painted; the
    // real zoom lands once the gesture goes quiet.
    Effect::new(move |_| {
        let (Some(el), Some(list_el)) = (container.get(), list.get()) else {
            return;
        };
        let pinch: Rc<RefCell<(Option<f64>, i32)>> = Rc::new(RefCell::new((None, 0)));
        // The closure owns one handle on the element; the listener is added through another.
        let target = el.clone();
        let on_wheel =
            Closure::<dyn FnMut(web_sys::WheelEvent)>::new(move |e: web_sys::WheelEvent| {
                if !e.ctrl_key() && !e.meta_key() {
                    return;
                }
                e.prevent_default();
                let g = geometry.get_untracked();
                if g.scale <= 0.0 {
                    return;
                }
                let current = zoom.get_untracked();
                let mut state = pinch.borrow_mut();
                let from = state.0.unwrap_or(current);
                let step = e.delta_y().clamp(-25.0, 25.0);
                let next = (from * (-step * 0.01).exp()).clamp(ZOOM_MIN, ZOOM_MAX);
                if next == from {
                    return;
                }
                if state.0.is_none() {
                    // The gesture anchors where it starts; layout holds still until it ends.
                    let box_ = el.get_bounding_client_rect();
                    let lr = list_el.get_bounding_client_rect();
                    let x = f64::from(e.client_x()) - box_.left();
                    let y = f64::from(e.client_y()) - box_.top();
                    // The list sits below the viewport's toolbar padding; anchor in its own coordinates.
                    let pad = lr.top() - box_.top() + f64::from(el.scroll_top());
                    let (tops, heights, _) = layout.get_untracked();
                    let pos =
                        position_from_scroll(&tops, &heights, f64::from(e.client_y()) - lr.top());
                    let from_center =
                        (f64::from(el.scroll_left()) + x - g.list_width / 2.0) / g.scale;
                    zoom_anchor.set_value(Some(ZoomAnchor {
                        x,
                        y: y - pad,
                        page: pos.page,
                        offset: pos.offset,
                        from_center,
                    }));
                    let _ = web_sys::HtmlElement::style(&list_el).set_property(
                        "transform-origin",
                        &format!(
                            "{}px {}px",
                            f64::from(e.client_x()) - lr.left(),
                            f64::from(e.client_y()) - lr.top()
                        ),
                    );
                }
                state.0 = Some(next);
                let _ = web_sys::HtmlElement::style(&list_el)
                    .set_property("transform", &format!("scale({})", next / current));
                window().clear_timeout_with_handle(state.1);
                let settle = pinch.clone();
                let list_clear = list_el.clone();
                let commit = Closure::once_into_js(move || {
                    let next = settle.borrow_mut().0.take();
                    if let Some(next) = next {
                        // Unchanged zoom means no new layout to clear the stretch, so clear it here.
                        if next == zoom.get_untracked() {
                            let _ = web_sys::HtmlElement::style(&list_clear)
                                .remove_property("transform");
                        } else {
                            zoom.set(next);
                        }
                    }
                });
                state.1 = window()
                    .set_timeout_with_callback_and_timeout_and_arguments_0(
                        commit.unchecked_ref(),
                        PINCH_SETTLE_MS,
                    )
                    .unwrap_or(0);
            });
        let opts = web_sys::AddEventListenerOptions::new();
        opts.set_passive(false);
        let _ = target.add_event_listener_with_callback_and_add_event_listener_options(
            "wheel",
            on_wheel.as_ref().unchecked_ref(),
            &opts,
        );
        on_wheel.forget();
    });

    // Which pages are near enough to draw. Two observers, made once; each page
    // observes itself when it mounts (a page that mounted before the observers
    // existed would otherwise never be seen).
    let visible = RwSignal::new(HashSet::<u32>::new());
    let near = RwSignal::new(HashSet::<u32>::new());
    let observers: StoredValue<Vec<web_sys::IntersectionObserver>, LocalStorage> =
        StoredValue::new_local(vec![]);
    Effect::new(move |_| {
        let Some(root) = container.get() else { return };
        let make = |set: RwSignal<HashSet<u32>>,
                    margin: &str|
         -> Option<web_sys::IntersectionObserver> {
            let cb = Closure::<dyn FnMut(js_sys::Array)>::new(move |entries: js_sys::Array| {
                set.update(|pages| {
                    for entry in entries.iter() {
                        let entry: web_sys::IntersectionObserverEntry = entry.unchecked_into();
                        let page = entry
                            .target()
                            .get_attribute("data-page")
                            .and_then(|p| p.parse().ok())
                            .unwrap_or(0);
                        if entry.is_intersecting() {
                            pages.insert(page);
                        } else {
                            pages.remove(&page);
                        }
                    }
                });
            });
            let init = web_sys::IntersectionObserverInit::new();
            init.set_root(Some(&root));
            init.set_root_margin(margin);
            let io =
                web_sys::IntersectionObserver::new_with_options(cb.as_ref().unchecked_ref(), &init)
                    .ok()?;
            cb.forget();
            Some(io)
        };
        let made: Vec<_> = [make(visible, RENDER_MARGIN), make(near, THUMB_MARGIN)]
            .into_iter()
            .flatten()
            .collect();
        // Pages already on screen register now; later ones register as they mount.
        if let Some(list_el) = list.get_untracked() {
            if let Ok(pages) = list_el.query_selector_all(".reader-page") {
                for i in 0..pages.length() {
                    if let Some(p) = pages
                        .item(i)
                        .and_then(|n| n.dyn_into::<web_sys::Element>().ok())
                    {
                        made.iter().for_each(|o| o.observe(&p));
                    }
                }
            }
        }
        observers.set_value(made);
        on_cleanup(move || observers.with_value(|os| os.iter().for_each(|o| o.disconnect())));
    });

    // Where a figure or link jump left from; Back returns there. Chained jumps keep the first spot.
    let back_to = RwSignal::new(None::<(u32, f64)>);
    let jump_to = move |page: u32, offset: f64, anchor: Option<f64>| {
        if back_to.get_untracked().is_none() {
            back_to.set(Some(last_pos.get_value()));
        }
        scroll_to(page, offset, nav_smooth(), anchor);
    };

    let raf: StoredValue<Option<AnimationFrameRequestHandle>, LocalStorage> =
        StoredValue::new_local(None);
    let scrolled = on_scroll;
    let on_scroll = move |_| {
        if let Some(cb) = scrolled {
            cb.run(());
        }
        if let Some(h) = raf.try_update_value(Option::take).flatten() {
            h.cancel();
        }
        let h = request_animation_frame_with_handle(move || {
            let Some(el) = container.get_untracked() else {
                return;
            };
            let (tops, heights, _) = layout.get_untracked();
            if tops.is_empty() {
                return;
            }
            let pos = position_from_scroll(
                &tops,
                &heights,
                f64::from(el.scroll_top()) + f64::from(el.client_height()) / 2.0,
            );
            last_pos.set_value((pos.page, pos.offset));
            on_position.run(pos);
        })
        .ok();
        raf.set_value(h);
    };

    let on_click = move |e: web_sys::MouseEvent| {
        if e.button() != 0 {
            return;
        }
        let Some(target) = e
            .target()
            .and_then(|t| t.dyn_into::<web_sys::Element>().ok())
        else {
            return;
        };
        if target.closest(".reader-link").ok().flatten().is_some() {
            return;
        }
        if let Some(fig) = target.closest(".fig-ref").ok().flatten() {
            let selecting = window()
                .get_selection()
                .ok()
                .flatten()
                .is_some_and(|s| !s.is_collapsed());
            let key = fig.get_attribute("data-figure").unwrap_or_default();
            if let (false, Some(p)) = (selecting, figures.with_untracked(|f| f.get(&key).copied()))
            {
                jump_to(p.page, p.offset, None);
            }
            return;
        }
        if let Some(cb) = on_text_click {
            cb.run(e);
        }
    };

    let page_count = Memo::new(move |_| sizes.with(Vec::len) as u32);
    view! {
        <div class="reader-viewport" node_ref=container role="region" aria-label="PDF document" tabindex="0" on:scroll=on_scroll on:click=on_click>
            <div
                class="reader-page-list"
                node_ref=list
                style:height=move || format!("{}px", layout.get().2)
                style:width=move || format!("{}px", geometry.get().list_width)
            >
                <Show when=move || { scale.get() > 0.0 }>
                    <For each=move || 1..=page_count.get() key=|n| *n let:page>
                        {
                            let i = page as usize - 1;
                            let style_top = move || format!("{}px", layout.with(|l| l.0.get(i).copied().unwrap_or(0.0)));
                            let style_h = move || format!("{}px", layout.with(|l| l.1.get(i).copied().unwrap_or(0.0)));
                            let style_w = move || format!("{}px", sizes.with(|s| s.get(i).map_or(0.0, |p| p.width)) * scale.get());
                            let page_el: NodeRef<html::Div> = NodeRef::new();
                            Effect::new(move |_| {
                                if let Some(el) = page_el.get() {
                                    observers.with_value(|os| os.iter().for_each(|o| o.observe(&el)));
                                    on_cleanup(move || observers.with_value(|os| os.iter().for_each(|o| o.unobserve(&el))));
                                }
                            });
                            view! {
                                <div
                                    node_ref=page_el
                                    data-page=page
                                    class="reader-page"
                                    role="group"
                                    aria-label=move || format!("Page {page} of {}", page_count.get())
                                    style:top=style_top
                                    style:width=style_w
                                    style:height=style_h
                                    style=("--scale-factor", move || scale.get().to_string())
                                >
                                    <Show when=move || near.with(|n| n.contains(&page))>
                                        <PageCanvas doc=doc page=page scale=Signal::derive(|| THUMB_SCALE) thumb=true />
                                    </Show>
                                    <Show when=move || { visible.with(|v| v.contains(&page)) && (render_scale.get() > 0.0) }>
                                        <PageCanvas doc=doc page=page scale=render_scale.into() thumb=false />
                                        <PageTextLayer doc=doc page=page scale=render_scale.into() figures=figures />
                                        <PageLinkLayer doc=doc page=page scale=render_scale.into() on_dest=Callback::new(move |dest: (u32, f64)| jump_to(dest.0, dest.1, Some(24.0))) />
                                        {page_extra.map(|f| f.run(page))}
                                    </Show>
                                </div>
                            }
                        }
                    </For>
                </Show>
            </div>
        </div>
        {move || back_to.get().map(|(page, offset)| view! {
            <button type="button" class="reader-back-btn" on:click=move |_| {
                scroll_to(page, offset, nav_smooth(), None);
                back_to.set(None);
            }>
                "← Back to reading"
            </button>
        })}
    }
}

#[component]
fn PageCanvas(
    doc: StoredValue<JsValue, LocalStorage>,
    page: u32,
    scale: Signal<f64>,
    thumb: bool,
) -> impl IntoView {
    let canvas: NodeRef<html::Canvas> = NodeRef::new();
    let task: StoredValue<Option<JsValue>, LocalStorage> = StoredValue::new_local(None);
    Effect::new(move |_| {
        let s = scale.get();
        let Some(c) = canvas.get() else { return };
        if let Some(t) = task.try_update_value(Option::take).flatten() {
            pdfjs::cancel(&t);
        }
        let t = doc.with_value(|d| pdfjs::render_page(d, page, &c, s, thumb, &pdfjs::recolor_fn()));
        task.set_value(Some(t));
    });
    on_cleanup(move || {
        if let Some(t) = task.try_update_value(Option::take).flatten() {
            pdfjs::cancel(&t);
        }
    });
    view! { <canvas node_ref=canvas class=if thumb { "reader-canvas reader-thumb" } else { "reader-canvas" }></canvas> }
}

/// The invisible selectable-text overlay, sized from the CSS variables pdf.js
/// sets; figure mentions are wrapped in place once it has rendered.
#[component]
fn PageTextLayer(
    doc: StoredValue<JsValue, LocalStorage>,
    page: u32,
    scale: Signal<f64>,
    figures: ReadSignal<HashMap<String, PdfPosition>>,
) -> impl IntoView {
    let layer: NodeRef<html::Div> = NodeRef::new();
    let rendered = RwSignal::new(0u32);
    let task: StoredValue<Option<JsValue>, LocalStorage> = StoredValue::new_local(None);
    Effect::new(move |_| {
        let s = scale.get();
        let Some(el) = layer.get() else { return };
        if let Some(t) = task.try_update_value(Option::take).flatten() {
            pdfjs::cancel(&t);
        }
        let t = doc.with_value(|d| pdfjs::text_layer(d, page, &el, s));
        task.set_value(Some(t.clone()));
        leptos::task::spawn_local(async move {
            pdfjs::finished(&t).await;
            rendered.update(|g| *g += 1);
        });
    });
    on_cleanup(move || {
        if let Some(t) = task.try_update_value(Option::take).flatten() {
            pdfjs::cancel(&t);
        }
    });
    Effect::new(move |_| {
        let known: HashSet<String> = figures.with(|f| f.keys().cloned().collect());
        if rendered.get() == 0 || known.is_empty() {
            return;
        }
        if let Some(el) = layer.get_untracked() {
            wrap_figure_refs(&el, &known);
        }
    });
    view! { <div node_ref=layer class="textLayer"></div> }
}

/// Split text nodes around known figure mentions; the characters are
/// unchanged, so selection and copy still work.
fn wrap_figure_refs(container: &web_sys::HtmlElement, known: &HashSet<String>) {
    let doc = document();
    let Ok(walker) = doc.create_tree_walker_with_what_to_show(container, 4) else {
        return;
    }; // NodeFilter.SHOW_TEXT
    let mut nodes = Vec::new();
    while let Ok(Some(n)) = walker.next_node() {
        nodes.push(n);
    }
    for node in nodes {
        if node
            .parent_element()
            .and_then(|p| p.closest(".fig-ref").ok().flatten())
            .is_some()
        {
            continue;
        }
        let text = node.node_value().unwrap_or_default();
        let parts = split_mentions(&text, known);
        if !parts.iter().any(|p| matches!(p, Segment::Ref { .. })) {
            continue;
        }
        let frag = doc.create_document_fragment();
        for part in parts {
            let _ = match part {
                Segment::Text(t) => frag.append_child(&doc.create_text_node(&t)),
                Segment::Ref { key, text } => {
                    let Ok(span) = doc.create_element("span") else {
                        continue;
                    };
                    span.set_class_name("fig-ref");
                    let _ = span.set_attribute("data-figure", &key);
                    span.set_text_content(Some(&text));
                    frag.append_child(&span)
                }
            };
        }
        if let Some(parent) = node.parent_node() {
            let _ = parent.replace_child(&frag, &node);
        }
    }
}

/// The page's link annotations as real anchors over the text: external links
/// open in a new tab, internal ones (citations, section refs) jump in place.
#[component]
fn PageLinkLayer(
    doc: StoredValue<JsValue, LocalStorage>,
    page: u32,
    scale: Signal<f64>,
    on_dest: Callback<(u32, f64)>,
) -> impl IntoView {
    let links = RwSignal::new_local(Vec::<(pdfjs::Link, JsValue)>::new());
    Effect::new(move |_| {
        let s = scale.get();
        let d = doc.get_value();
        leptos::task::spawn_local(async move {
            links.set(pdfjs::page_links(&d, page, s).await.unwrap_or_default());
        });
    });
    move || {
        let all = links.get();
        (!all.is_empty()).then(|| {
            view! {
                <div class="reader-links">
                    {all.into_iter().map(|(link, dest)| {
                        let style = format!("left: {}px; top: {}px; width: {}px; height: {}px", link.left, link.top, link.width, link.height);
                        match link.url {
                            Some(url) => view! { <a class="reader-link" style=style href=url.clone() target="_blank" rel="noopener noreferrer" title=url></a> }.into_any(),
                            None => {
                                let dest = StoredValue::new_local(dest);
                                view! {
                                    <a class="reader-link" style=style href="#" aria-label="Go to linked spot in this document" on:click=move |e| {
                                        e.prevent_default();
                                        let d = doc.get_value();
                                        let target = dest.get_value();
                                        leptos::task::spawn_local(async move {
                                            if let Some(p) = pdfjs::resolve_dest(&d, &target).await {
                                                on_dest.run(p);
                                            }
                                        });
                                    }></a>
                                }
                                .into_any()
                            }
                        }
                    }).collect_view()}
                </div>
            }
        })
    }
}

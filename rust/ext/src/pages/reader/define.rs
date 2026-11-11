//! Click-to-define and select-to-highlight: reading the DOM back into page
//! fractions and words. The word rules are reader_core's.

use crate::chrome;
use crate::pages::ai::{use_ai, AiNote, AiStatus, SaveNotePrompt};
use crate::pages::lexicon::TermSources;
use leptos::html;
use leptos::prelude::*;
use reader_core::ai::define_request;
use reader_core::annotations::{merge_line_rects, normalize_rects, Box};
use reader_core::clicked_word::clicked_word;
use reader_core::constants::ANNOTATION_TEXT_MAX_CHARS;
use reader_core::constants::LEXICON_PAGE_PATH;
use reader_core::lexicon::{split_definition, term_key, Lexicon};
use reader_core::types::AnnotationRect;
use reader_core::utf16::{chars_to_utf16, utf16_to_chars};
use wasm_bindgen::JsCast;
use web_sys::{Element, Node};

/// A clicked term, with the boxes a kept definition becomes a highlight on.
#[derive(Clone, Debug)]
pub struct DefineTarget {
    pub word: String,
    pub context: String,
    pub near: String,
    /// Viewport px; the popover opens below the word when `flip`
    pub x: f64,
    pub y: f64,
    pub flip: bool,
    pub page: u32,
    pub rects: Vec<AnnotationRect>,
}

/// A selection waiting for a colour; one highlight per page it spans.
#[derive(Clone, Debug)]
pub struct PendingSelection {
    pub x: f64,
    pub y: f64,
    pub text: String,
    pub by_page: Vec<(u32, Vec<AnnotationRect>)>,
}

fn to_box(r: &web_sys::DomRect) -> Box {
    Box {
        left: r.left(),
        top: r.top(),
        width: r.width(),
        height: r.height(),
    }
}

fn viewport_size() -> (f64, f64) {
    let w = window();
    let get = |v: Result<wasm_bindgen::JsValue, _>| v.ok().and_then(|v| v.as_f64()).unwrap_or(0.0);
    (get(w.inner_width()), get(w.inner_height()))
}

fn selecting() -> bool {
    window()
        .get_selection()
        .ok()
        .flatten()
        .is_some_and(|s| !s.is_collapsed())
}

/// The term under a click on the text layer, or `None` for a space, a
/// double click (that selects) or a click while text is selected.
pub fn define_target(e: &web_sys::MouseEvent) -> Option<DefineTarget> {
    if e.detail() > 1 || selecting() {
        return None;
    }
    let el: Element = e.target()?.dyn_into().ok()?;
    let span = el.closest(".textLayer span").ok()??;
    let layer = span.closest(".textLayer").ok()??;
    let caret = document().caret_position_from_point(e.client_x() as f32, e.client_y() as f32)?;
    let node = caret.offset_node()?;
    if node.node_type() != Node::TEXT_NODE || !span.contains(Some(&node)) {
        return None;
    }
    let data = node.node_value().unwrap_or_default();
    let caret_char = utf16_to_chars(&data, caret.offset() as usize);

    // The page's text as one string, runs joined by a space, so the model reads the whole sentence.
    let walker = document()
        .create_tree_walker_with_what_to_show(&layer, 4)
        .ok()?; // SHOW_TEXT
    let (mut text, mut chars, mut offset) = (String::new(), 0usize, None);
    while let Ok(Some(n)) = walker.next_node() {
        let value = n.node_value().unwrap_or_default();
        if n.is_same_node(Some(&node)) {
            offset = Some(chars + caret_char);
        }
        chars += value.chars().count() + 1;
        text.push_str(&value);
        text.push(' ');
    }
    let offset = offset?;
    // The caret lands on the nearer edge of a glyph: past the last letter when its right half is clicked.
    let hit = clicked_word(&text, offset)
        .or_else(|| offset.checked_sub(1).and_then(|o| clicked_word(&text, o)))?;

    // The word's own boxes; a word split across text runs falls back to the clicked run.
    let range = document().create_range().ok()?;
    let data_chars: Vec<char> = data.chars().collect();
    let word_chars: Vec<char> = hit.word.chars().collect();
    let wl = word_chars.len();
    let at = (0..=caret_char.min(data_chars.len().saturating_sub(wl)))
        .rev()
        .find(|&s| data_chars.get(s..s + wl) == Some(&word_chars[..]));
    match at {
        Some(s) if caret_char <= s + wl => {
            range
                .set_start(&node, chars_to_utf16(&data, s) as u32)
                .ok()?;
            range
                .set_end(&node, chars_to_utf16(&data, s + wl) as u32)
                .ok()?;
        }
        _ => range.select_node_contents(&span).ok()?,
    }
    let page_el = span.closest(".reader-page").ok()??;
    let page = page_el.get_attribute("data-page")?.parse().ok()?;
    let list = range.get_client_rects()?;
    let boxes: Vec<Box> = (0..list.length())
        .filter_map(|i| list.get(i))
        .map(|r| to_box(&r))
        .collect();
    let rects = merge_line_rects(&normalize_rects(
        &boxes,
        to_box(&page_el.get_bounding_client_rect()),
    ));

    let (width, height) = viewport_size();
    let (cx, cy) = (f64::from(e.client_x()), f64::from(e.client_y()));
    let flip = cy < height / 2.0;
    Some(DefineTarget {
        word: hit.word,
        context: hit.context,
        near: hit.near,
        x: cx.max(184.0).min(width - 184.0),
        y: if flip { cy + 14.0 } else { cy - 14.0 },
        flip,
        page,
        rects,
    })
}

/// The current text selection inside the document as highlight boxes, each
/// rect assigned to the page whose box holds its centre (a selection can span pages).
pub fn pending_selection() -> Option<PendingSelection> {
    let sel = window().get_selection().ok()??;
    if sel.is_collapsed() || sel.range_count() == 0 {
        return None;
    }
    let anchor = sel.anchor_node()?;
    let anchor_el = match anchor.dyn_ref::<Element>() {
        Some(el) => el.clone(),
        None => anchor.parent_element()?,
    };
    anchor_el.closest(".reader-viewport").ok()??;
    let list = sel.get_range_at(0).ok()?.get_client_rects()?;
    let rects: Vec<web_sys::DomRect> = (0..list.length()).filter_map(|i| list.get(i)).collect();
    let last = rects.last()?.clone();

    let nodes = document()
        .query_selector_all(".reader-viewport .reader-page")
        .ok()?;
    let pages: Vec<(u32, Box)> = (0..nodes.length())
        .filter_map(|i| nodes.item(i)?.dyn_into::<Element>().ok())
        .filter_map(|el| {
            let page = el.get_attribute("data-page")?.parse().ok()?;
            Some((page, to_box(&el.get_bounding_client_rect())))
        })
        .collect();
    let mut raw: Vec<(u32, Box, Vec<Box>)> = vec![];
    for r in &rects {
        let (cx, cy) = (r.left() + r.width() / 2.0, r.top() + r.height() / 2.0);
        let Some((page, b)) = pages.iter().find(|(_, b)| {
            cx >= b.left && cx <= b.left + b.width && cy >= b.top && cy <= b.top + b.height
        }) else {
            continue;
        };
        match raw.iter_mut().find(|(p, ..)| p == page) {
            Some((_, _, list)) => list.push(to_box(r)),
            None => raw.push((*page, *b, vec![to_box(r)])),
        }
    }
    let by_page: Vec<_> = raw
        .into_iter()
        .map(|(page, b, list)| (page, merge_line_rects(&normalize_rects(&list, b))))
        .filter(|(_, r)| !r.is_empty())
        .collect();
    if by_page.is_empty() {
        return None;
    }
    let text: String = String::from(sel.unchecked_ref::<js_sys::Object>().to_string())
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(ANNOTATION_TEXT_MAX_CHARS)
        .collect();
    let (width, _) = viewport_size();
    Some(PendingSelection {
        x: (last.left() + last.width() / 2.0)
            .max(80.0)
            .min(width - 80.0),
        y: (last.top() - 10.0).max(40.0),
        text,
        by_page,
    })
}

/// A clicked term, guessed first: the reader says what they think it means
/// from the sentence around it, then compares with the paper's meaning,
/// streamed in next to it. Closes on any click outside.
#[component]
pub fn DefinePopover(
    target: DefineTarget,
    doc_key: String,
    on_close: Callback<()>,
    /// Once written: keep the definition as a note on the term
    on_save: Callback<String>,
    /// Once written: keep the term in the lexicon, with (definition, guess)
    on_keep: Callback<(String, String)>,
) -> impl IntoView {
    let ai = use_ai();
    let kept = RwSignal::new(false);
    let written = move || {
        ai.view
            .with(|v| v.status == AiStatus::Done && !v.text.is_empty())
    };
    let draft = RwSignal::new(String::new());
    let guess = RwSignal::new(None::<String>);
    // A snapshot on purpose: what was saved before this popover, not what it just kept.
    let previous = RwSignal::new(Lexicon::default());
    leptos::task::spawn_local(async move {
        if let Ok(lex) = crate::store::get::<Lexicon>("lexicon").await {
            previous.try_set(lex);
        }
    });
    let root: NodeRef<html::Div> = NodeRef::new();
    let input: NodeRef<html::Input> = NodeRef::new();

    let outside = window_event_listener(leptos::ev::pointerdown, move |e| {
        let inside = root
            .get_untracked()
            .zip(e.target().and_then(|t| t.dyn_into::<Node>().ok()))
            .is_some_and(|(el, t)| el.contains(Some(&t)));
        if !inside {
            on_close.run(());
        }
    });
    on_cleanup(move || outside.remove());
    Effect::new(move |_| {
        if let Some(i) = input.get() {
            let _ = i.focus();
        }
    });

    let DefineTarget {
        word,
        context,
        near,
        x,
        y,
        flip,
        ..
    } = target;
    let (_, height) = viewport_size();
    let style = format!(
        "left: {x}px; top: {y}px; max-height: {}px;{}",
        if flip { height - y } else { y } - 12.0,
        if flip {
            " transform: translate(-50%, 0);"
        } else {
            ""
        }
    );
    let request = StoredValue::new(define_request(&doc_key, &word, &context, &near));
    let clicked = term_key(&word);
    let saved = Memo::new(move |_| {
        let key = ai
            .view
            .with(|v| {
                if v.status == AiStatus::Done {
                    split_definition(&v.text).0.map(|label| term_key(&label))
                } else {
                    None
                }
            })
            .unwrap_or_else(|| clicked.clone());
        previous.with(|lex| lex.terms.iter().find(|t| t.id == key).cloned())
    });
    let submit = move |e: web_sys::SubmitEvent| {
        e.prevent_default();
        let text = draft.get_untracked().trim().to_string();
        if !text.is_empty() {
            guess.set(Some(text));
            ai.start(request.get_value());
        }
    };
    let question = format!("From the sentence around it, what do you think “{word}” means here?");
    view! {
        <div node_ref=root class="popover-card define-popover" role="dialog" aria-label=format!("Definition of {word}") style=style>
            <Show
                when=move || guess.with(Option::is_some)
                fallback=move || view! {
                    <form class="define-guess" on:submit=submit>
                        <label class="define-guess-question" for="define-guess-input">{question.clone()}</label>
                        <input node_ref=input id="define-guess-input" class="answer-input" prop:value=move || draft.get() on:input=move |e| draft.set(event_target_value(&e)) />
                        <button type="submit" class="fc-primary-btn" disabled=move || draft.with(|d| d.trim().is_empty())>"Compare"</button>
                    </form>
                }
            >
                <p class="small-label">"Your guess"</p>
                <p class="define-guess-text">{move || guess.get().unwrap_or_default()}</p>
                <p class="small-label">"In the paper"</p>
                <AiNote ai=ai />
                {move || saved.get().map(|term| view! {
                    <details class="define-saved" open>
                        <summary>{format!("Previously saved: {}", term.label)}</summary>
                        <TermSources sources=term.sources />
                    </details>
                })}
                <SaveNotePrompt ai=ai on_save=Callback::new(move |note: String| {
                    on_save.run(format!("Your guess: {} / Paper: {note}", guess.get_untracked().unwrap_or_default()));
                    on_close.run(());
                }) />
                <Show when=written>
                    <div class="ai-note-actions">
                        <Show
                            when=move || kept.get()
                            fallback=move || view! {
                                <button type="button" class="ai-note-btn" on:click=move |_| {
                                    on_keep.run((ai.view.with_untracked(|v| v.text.clone()), guess.get_untracked().unwrap_or_default()));
                                    kept.set(true);
                                }>"Add to lexicon"</button>
                            }
                        >
                            <a class="ai-note-link" href=chrome::get_url(LEXICON_PAGE_PATH) target="_blank">"In your lexicon ↗"</a>
                        </Show>
                    </div>
                </Show>
            </Show>
        </div>
    }
}

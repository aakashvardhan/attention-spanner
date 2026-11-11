//! A video's takeaways, drawn in their kind's shape: Cornell notes for a
//! lecture, steps for a tutorial, ideas for an explainer. In the side panel a
//! timestamp seeks the video; on the Notes page it links to that moment.

use leptos::prelude::*;
use reader_core::youtube::{
    cornell_cards, group, seconds, stamp, watch_url, Kind, Stamped, VideoNotes,
};

#[component]
fn Stamp(t: String, id: String, on_seek: Option<Callback<u32>>) -> impl IntoView {
    match (seconds(&t), on_seek) {
        (Some(s), Some(seek)) => view! {
            <button type="button" class="stamp" aria-label=format!("Play from {}", stamp(s)) on:click=move |_| seek.run(s)>{stamp(s)}</button>
        }
        .into_any(),
        (Some(s), None) => view! {
            <a class="stamp" href=format!("{}&t={s}s", watch_url(&id)) target="_blank" rel="noopener" aria-label=format!("{}, opens YouTube", stamp(s))>{stamp(s)}</a>
        }
        .into_any(),
        (None, _) => view! { <span class="stamp">{t}</span> }.into_any(),
    }
}

/// One Cornell cue as a study card: the question, its notes covered until
/// asked for, so you answer it in your head first.
#[component]
fn CueCard(
    cue: Stamped,
    notes: Vec<Stamped>,
    id: String,
    on_seek: Option<Callback<u32>>,
) -> impl IntoView {
    let shown = RwSignal::new(false);
    let id2 = id.clone();
    let list = move || {
        notes
            .iter()
            .map(|n| view! { <li><Stamp t=n.t.clone() id=id2.clone() on_seek=on_seek />" "<span>{n.text.clone()}</span></li> })
            .collect_view()
    };
    view! {
        <article class="cue-card" data-shown=move || shown.get().to_string()>
            <div class="cue-card-cue">
                <p><Stamp t=cue.t.clone() id=id on_seek=on_seek />" "<span>{cue.text.clone()}</span></p>
                <button type="button" class="cue-card-toggle" aria-expanded=move || shown.get().to_string()
                    on:click=move |_| shown.update(|v| *v = !*v)>
                    {move || if shown.get() { "Cover notes" } else { "Show notes" }}
                </button>
            </div>
            <div class="cue-card-notes">
                {move || if shown.get() {
                    view! { <ul>{list()}</ul> }.into_any()
                } else {
                    view! { <p class="cue-card-cover">"Answer it in your head first."</p> }.into_any()
                }}
            </div>
        </article>
    }
}

/// Notes taken a part at a time show part by part, each under its range.
#[component]
pub fn NotesView(notes: VideoNotes, on_seek: Option<Callback<u32>>) -> impl IntoView {
    let parts = group(&notes);
    let inner = if parts.is_empty() {
        body(&notes, on_seek)
    } else {
        parts
            .into_iter()
            .map(|(sec, sub)| {
                let range = sec.range();
                let label = format!("Part {range}");
                view! {
                    <section class="notes-part" aria-label=label>
                        <h3 class="notes-part-range">{range}</h3>
                        {body(&sub, on_seek)}
                    </section>
                }
            })
            .collect_view()
            .into_any()
    };
    view! { <div class="video-notes" data-kind=notes.kind.label().to_lowercase()>{inner}</div> }
}

fn body(notes: &VideoNotes, on_seek: Option<Callback<u32>>) -> AnyView {
    let id = notes.id.clone();
    let s = move |t: &String| view! { <Stamp t=t.clone() id=id.clone() on_seek=on_seek /> };
    match notes.kind {
        Kind::Lecture => {
            let cards = cornell_cards(notes);
            // Without cues there is nothing to quiz on: the notes as a list.
            let column = if cards.is_empty() {
                view! {
                    <section aria-label="Notes">
                        <h3>"Notes"</h3>
                        <ul>{notes.notes.iter().map(|c| view! { <li>{s(&c.t)}" "<span>{c.text.clone()}</span></li> }).collect_view()}</ul>
                    </section>
                }
                .into_any()
            } else {
                let id = notes.id.clone();
                view! {
                    <section class="cornell" aria-label="Cues">
                        {cards.into_iter().map(|(cue, ns)| view! { <CueCard cue=cue notes=ns id=id.clone() on_seek=on_seek /> }).collect_view()}
                    </section>
                }
                .into_any()
            };
            view! {
                {column}
                <section class="cue-card cue-card-summary" aria-label="Summary">
                    <h3>"Summary"</h3>
                    <p>{notes.summary.clone()}</p>
                </section>
            }
            .into_any()
        }
        Kind::Tutorial => view! {
            <p class="notes-lede">{notes.summary.clone()}</p>
            {(!notes.prerequisites.is_empty()).then(|| view! {
                <h3>"Before you start"</h3>
                <ul>{notes.prerequisites.iter().map(|p| view! { <li>{p.clone()}</li> }).collect_view()}</ul>
            })}
            <h3>"Steps"</h3>
            <ol>
                {notes.steps.iter().map(|st| view! {
                    <li>
                        {s(&st.t)}" "<span>{st.text.clone()}</span>
                        {(!st.code.is_empty()).then(|| view! { <pre><code>{st.code.clone()}</code></pre> })}
                        {(!st.gotcha.is_empty()).then(|| view! { <p class="gotcha"><strong>"Watch out: "</strong><span>{st.gotcha.clone()}</span></p> })}
                    </li>
                }).collect_view()}
            </ol>
        }
        .into_any(),
        Kind::Educational => view! {
            <p class="notes-lede">{notes.question.clone()}</p>
            <h3>"Key ideas"</h3>
            <ol>
                {notes.ideas.iter().map(|i| view! {
                    <li>{s(&i.t)}" "<strong>{i.idea.clone()}</strong><p>{i.intuition.clone()}</p></li>
                }).collect_view()}
            </ol>
            <h3>"So what"</h3>
            <p>{notes.summary.clone()}</p>
        }
        .into_any(),
    }
}

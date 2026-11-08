//! A video's takeaways, drawn in their kind's shape: Cornell notes for a
//! lecture, steps for a tutorial, ideas for an explainer. In the side panel a
//! timestamp seeks the video; on the Notes page it links to that moment.

use leptos::prelude::*;
use reader_core::youtube::{group, seconds, stamp, Kind, VideoNotes};

#[component]
fn Stamp(t: String, id: String, on_seek: Option<Callback<u32>>) -> impl IntoView {
    match (seconds(&t), on_seek) {
        (Some(s), Some(seek)) => view! {
            <button type="button" class="stamp" aria-label=format!("Play from {}", stamp(s)) on:click=move |_| seek.run(s)>{stamp(s)}</button>
        }
        .into_any(),
        (Some(s), None) => view! {
            <a class="stamp" href=format!("https://www.youtube.com/watch?v={id}&t={s}s") target="_blank" rel="noopener" aria-label=format!("{}, opens YouTube", stamp(s))>{stamp(s)}</a>
        }
        .into_any(),
        (None, _) => view! { <span class="stamp">{t}</span> }.into_any(),
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
        Kind::Lecture => view! {
            <div class="cornell">
                <section aria-label="Cues">
                    <h3>"Cues"</h3>
                    <ul>{notes.cues.iter().map(|c| view! { <li>{s(&c.t)}" "<span>{c.text.clone()}</span></li> }).collect_view()}</ul>
                </section>
                <section aria-label="Notes">
                    <h3>"Notes"</h3>
                    <ul>{notes.notes.iter().map(|c| view! { <li>{s(&c.t)}" "<span>{c.text.clone()}</span></li> }).collect_view()}</ul>
                </section>
            </div>
            <section aria-label="Summary">
                <h3>"Summary"</h3>
                <p>{notes.summary.clone()}</p>
            </section>
        }
        .into_any(),
        Kind::Tutorial => view! {
            <p class="notes-lede">{notes.summary.clone()}</p>
            {(!notes.prerequisites.is_empty()).then(|| view! {
                <h3>"Before you start"</h3>
                <ul>{notes.prerequisites.iter().map(|p| view! { <li>{p.clone()}</li> }).collect_view()}</ul>
            })}
            <h3>"Steps"</h3>
            <ol class="steps">
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
            <ol class="ideas">
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

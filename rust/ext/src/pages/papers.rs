//! The papers page: one section per alphaXiv folder (src/pages/papers/Papers.tsx).
//! ponytail: a plain list until the library shelf replaces it (papers-library step 5).

use super::{send, use_storage};
use crate::chrome;
use leptos::prelude::*;
use reader_core::constants::NEWTAB_PAGE_PATH;
use reader_core::papers::group_by_folder;
use reader_core::pdf::paper_open_url;
use reader_core::types::{Folder, Paper};
use serde_json::json;

#[oxichrome::page(path = "src/pages/papers/index.html", title = "Papers", css = ["assets/theme.css", "assets/papers.css"])]
pub fn Papers() -> impl IntoView {
    let (papers, _) = use_storage::<Vec<Paper>>("papers");
    let (folders, _) = use_storage::<Vec<Folder>>("folders");
    // The shelf is alphaXiv's: refresh it (at most every two minutes) whenever this page opens.
    leptos::task::spawn_local(async {
        send(json!({ "type": "ALPHAXIV_SYNC" })).await;
    });
    let by_folder = Memo::new(move |_| papers.with(|p| group_by_folder(p)));
    let base = chrome::get_url("");
    view! {
        <div id="root">
            <div class="library grid">
                <header class="library-masthead">
                    <a class="ghost-btn" href=chrome::get_url(NEWTAB_PAGE_PATH)>"← Today"</a>
                    <h1>"Papers"</h1>
                </header>
                <section class="library-papers">
                    <Show when=move || folders.with(Vec::is_empty)>
                        <p class="library-hint">"Sign in to alphaXiv in Settings to bring in your library."</p>
                    </Show>
                    <For each=move || folders.get() key=|f| f.id.clone() let:folder>
                        {
                            let heading = format!("folder-{}", folder.id);
                            let labelled_by = heading.clone();
                            let id = folder.id.clone();
                            let base = base.clone();
                            view! {
                                <section aria-labelledby=labelled_by>
                                    <h2 id=heading>{folder.name}</h2>
                                    <ul>
                                        {move || by_folder.with(|b| b.get(&id).cloned().unwrap_or_default()).into_iter().map(|p| {
                                            let href = paper_open_url(&p, false, &base);
                                            view! { <li><a href=href>{p.title}</a></li> }
                                        }).collect_view()}
                                    </ul>
                                </section>
                            }
                        }
                    </For>
                </section>
            </div>
        </div>
    }
}

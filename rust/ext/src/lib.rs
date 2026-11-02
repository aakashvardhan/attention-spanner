//! The extension, compiled to WebAssembly. One crate becomes one `.wasm`
//! module: the background worker and every page load it and call the export
//! they need (oxichrome generates the loaders from the attributes below).

use leptos::prelude::*;

mod chrome;
mod js;
mod store;
mod worker;

#[oxichrome::extension(
    name = "Reader",
    version = "1.0.0",
    description = "A quiet companion to alphaXiv: a paper shelf, and a reader that asks instead of tells and blocks what pulls you away.",
    permissions = ["storage", "alarms", "declarativeNetRequest", "identity"],
    host_permissions = ["<all_urls>"]
)]
struct Reader;

/// Phase 0's only page: proves a Leptos component mounts on the new tab with
/// the shared stylesheets. Replaced by the real new tab in phase 3.
#[oxichrome::page(
    path = "src/pages/newtab/index.html",
    title = "New Tab",
    css = ["assets/theme.css", "assets/newtab.css"]
)]
fn NewTab() -> impl IntoView {
    view! {
        <main class="edition">
            <p class="hint">{reader_core::APP_NAME}", in Rust."</p>
        </main>
    }
}

//! The extension, compiled to WebAssembly. One crate becomes one `.wasm`
//! module: the background worker and every page load it and call the export
//! they need (oxichrome generates the loaders from the attributes below).

mod cache;
mod chrome;
mod claude;
mod gemini;
mod js;
mod page_text;
mod pages;
mod pdfjs;
mod store;
mod vault;
mod voice;
mod worker;

#[oxichrome::extension(
    name = "Reader",
    version = "1.0.0",
    description = "A quiet companion to alphaXiv: a paper shelf, and a reader that asks instead of tells and blocks what pulls you away.",
    permissions = ["storage", "alarms", "declarativeNetRequest", "identity", "notifications", "geolocation", "offscreen", "scripting", "sidePanel"],
    host_permissions = ["<all_urls>"]
)]
struct Reader;

//! The extension's rules, as pure Rust: no `wasm_bindgen`, no `web_sys`, no
//! Chrome. Everything here runs (and is tested) natively with `cargo test`,
//! which is the quickest loop for learning the language. The `ext` crate does
//! the effects (storage, network, DOM) and calls in here for every decision.

pub mod activity;
pub mod ai;
pub mod alphaxiv;
pub mod annotations;
pub mod brain_dump;
pub mod civil_date;
pub mod clicked_word;
pub mod constants;
pub mod figures;
pub mod focus_rules;
pub mod format;
pub mod mcp;
pub mod messages;
pub mod migrations;
pub mod outline;
pub mod papers;
pub mod pdf;
pub mod reader_progress;
pub mod reading_aids;
pub mod types;

/// The extension's name, shared by the manifest and the pages.
pub const APP_NAME: &str = "Reader";

#[cfg(test)]
mod tests {
    #[test]
    fn the_name_is_set() {
        assert_eq!(super::APP_NAME, "Reader");
    }
}

//! The extension's rules, as pure Rust: no `wasm_bindgen`, no `web_sys`, no
//! Chrome. Everything here runs (and is tested) natively with `cargo test`,
//! which is the quickest loop for learning the language. The `ext` crate does
//! the effects (storage, network, DOM) and calls in here for every decision.

/// The extension's name, shared by the manifest and the pages.
pub const APP_NAME: &str = "Reader";

#[cfg(test)]
mod tests {
    #[test]
    fn the_name_is_set() {
        assert_eq!(super::APP_NAME, "Reader");
    }
}

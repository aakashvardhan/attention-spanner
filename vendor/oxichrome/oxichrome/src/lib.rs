pub use oxichrome_macros::{background, content_script, extension, on, options_page, page, popup};

pub use oxichrome_core as core;

pub use oxichrome_core::content_script::RunAt;
pub use oxichrome_core::error::{OxichromeError, Result};
pub use oxichrome_core::runtime;
pub use oxichrome_core::storage;
pub use oxichrome_core::tabs;

pub use oxichrome_core::__log_impl;
pub use oxichrome_core::log;

#[doc(hidden)]
pub mod __private {
    pub use js_sys;
    pub use leptos;
    pub use serde;
    pub use serde_json;
    pub use serde_wasm_bindgen;
    pub use wasm_bindgen;
    pub use wasm_bindgen_futures;
}

pub mod prelude {
    pub use crate::core::error;
    pub use crate::runtime;
    pub use crate::storage;
    pub use crate::tabs;
    pub use crate::{background, content_script, extension, on, options_page, page, popup};
    pub use crate::{OxichromeError, Result};
    pub use serde::{Deserialize, Serialize};
}

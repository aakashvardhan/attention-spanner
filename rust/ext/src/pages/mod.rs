//! The extension's pages, in Leptos. Each keeps the React version's markup
//! (element for element, class for class) so the same stylesheets draw it the
//! same way: the screenshot baselines are the check.

pub mod ai;
pub mod blocked;
pub mod dumps;
pub mod lexicon;
pub mod newtab;
pub mod options;
pub mod papers;
pub mod reader;
mod todo_drag;

use crate::chrome;
use crate::js::{from_js, to_js, wait};
use leptos::prelude::*;
use serde::de::DeserializeOwned;
use serde_json::Value;
use wasm_bindgen::prelude::*;

/// A storage key as a signal: `(value, loaded)`. Starts at the default, fills
/// in once read, and follows every later change (another tab, the worker).
/// The default stands in for a missing key, as the TS `useStorageValue` did.
pub fn use_storage<T>(key: &'static str) -> (ReadSignal<T>, ReadSignal<bool>)
where
    T: DeserializeOwned + Default + Clone + Send + Sync + 'static,
{
    let (value, set_value) = signal(T::default());
    let (loaded, set_loaded) = signal(false);
    let parse = |v: Option<Value>| {
        v.and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    };
    leptos::task::spawn_local(async move {
        if let Ok(v) = crate::store::get::<Value>(key).await {
            set_value.set(parse((!v.is_null()).then_some(v)));
        }
        set_loaded.set(true);
    });
    let listener =
        Closure::<dyn FnMut(JsValue, JsValue)>::new(move |changes: JsValue, area: JsValue| {
            if area.as_string().as_deref() != Some("local") {
                return;
            }
            let changes: Value = from_js(changes).unwrap_or_default();
            if let Some(change) = changes.get(key) {
                set_value.set(parse(change.get("newValue").cloned()));
            }
        });
    chrome::on_storage_changed(&listener);
    // The page lives as long as its listener: leak it on purpose.
    listener.forget();
    (value, loaded)
}

/// Settings merged over the defaults (the TS `useSettings`).
pub fn use_settings() -> (Signal<reader_core::types::Settings>, ReadSignal<bool>) {
    let (raw, loaded) = use_storage::<Value>("settings");
    let merged = Signal::derive(move || {
        let mut base =
            serde_json::to_value(reader_core::types::Settings::default()).unwrap_or_default();
        if let (Some(b), Value::Object(over)) = (base.as_object_mut(), raw.get()) {
            b.extend(over);
        }
        serde_json::from_value(base).unwrap_or_default()
    });
    (merged, loaded)
}

/// The palettes in theme.css, as (data-theme value, label). "paper" is the
/// unattributed default.
pub const THEMES: [(&str, &str); 6] = [
    ("grid", "Grid (dark, neon)"),
    ("paper", "Paper"),
    ("daylight", "Daylight (highest contrast)"),
    ("mist", "Mist"),
    ("graphite", "Graphite"),
    ("rose", "Rose"),
];

/// Follow the saved palette: sets html[data-theme], live across tabs.
pub fn use_theme() {
    let (settings, _) = use_settings();
    Effect::new(move |_| {
        let theme = settings.get().theme;
        if let Some(root) = web_sys::window()
            .and_then(|w| w.document())
            .and_then(|d| d.document_element())
        {
            let _ = if theme == "paper" {
                root.remove_attribute("data-theme")
            } else {
                root.set_attribute("data-theme", &theme)
            };
        }
    });
}

/// Send a message to the worker; the reply as JSON (`{ ok: false }` on failure).
pub async fn send(msg: Value) -> Value {
    let Ok(js) = to_js(&msg) else {
        return serde_json::json!({ "ok": false });
    };
    match wait(chrome::send_message(&js)).await {
        Ok(reply) => from_js(reply).unwrap_or_default(),
        Err(_) => serde_json::json!({ "ok": false }),
    }
}

/// Write one settings field, merged over what is stored.
pub async fn patch_settings(field: &str, value: Value) {
    let mut settings: Value = crate::store::get("settings").await.unwrap_or_default();
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    settings[field] = value;
    let _ = crate::store::set("settings", &settings).await;
}

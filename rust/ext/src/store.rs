//! chrome.storage, typed. A missing key reads as its default, as the TS
//! `getLocal` did with DEFAULTS.

use crate::chrome;
use crate::js::{from_js, to_js, wait, Res};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{Map, Value};

/// One key, or `T::default()` when absent (or unreadable: a corrupt value must not wedge the worker).
pub async fn get<T: DeserializeOwned + Default>(key: &str) -> Res<T> {
    let all: Map<String, Value> = from_js(wait(chrome::local_get(&to_js(&[key])?)).await?)?;
    Ok(all
        .get(key)
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

/// The whole of chrome.storage.local, for the migration.
pub async fn snapshot() -> Res<Map<String, Value>> {
    from_js(wait(chrome::local_get(&wasm_bindgen::JsValue::NULL)).await?)
}

pub async fn set<T: Serialize>(key: &str, value: &T) -> Res<()> {
    let mut items = Map::new();
    items.insert(
        key.into(),
        serde_json::to_value(value).map_err(|e| crate::js::error(e.to_string()))?,
    );
    set_many(&items).await
}

pub async fn set_many(items: &Map<String, Value>) -> Res<()> {
    wait(chrome::local_set(&to_js(items)?)).await.map(drop)
}

pub async fn remove(keys: &[String]) -> Res<()> {
    wait(chrome::local_remove(&to_js(keys)?)).await.map(drop)
}

pub async fn session_get<T: DeserializeOwned + Default>(key: &str) -> Res<T> {
    let all: Map<String, Value> = from_js(wait(chrome::session_get(&to_js(&[key])?)).await?)?;
    Ok(all
        .get(key)
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

pub async fn session_set<T: Serialize>(key: &str, value: &T) -> Res<()> {
    let mut items = Map::new();
    items.insert(
        key.into(),
        serde_json::to_value(value).map_err(|e| crate::js::error(e.to_string()))?,
    );
    wait(chrome::session_set(&to_js(&items)?)).await.map(drop)
}

pub async fn session_remove(keys: &[String]) -> Res<()> {
    wait(chrome::session_remove(&to_js(keys)?)).await.map(drop)
}

/// Settings merged over the defaults, so a profile older than a field reads its default.
pub async fn settings() -> Res<reader_core::types::Settings> {
    let stored: Value = get("settings").await?;
    let mut merged =
        serde_json::to_value(reader_core::types::Settings::default()).unwrap_or_default();
    if let (Some(base), Value::Object(over)) = (merged.as_object_mut(), stored) {
        base.extend(over);
    }
    Ok(serde_json::from_value(merged).unwrap_or_default())
}

/// Serialize read-modify-write operations across extension pages and the worker.
pub async fn with_lock<T: 'static>(
    name: &str,
    f: impl std::future::Future<Output = T> + 'static,
) -> T {
    use js_sys::Promise;
    use std::cell::RefCell;
    use std::rc::Rc;
    use wasm_bindgen::prelude::*;
    use wasm_bindgen_futures::JsFuture;
    #[wasm_bindgen]
    extern "C" {
        #[wasm_bindgen(js_namespace = ["navigator", "locks"], js_name = request)]
        fn locks_request(name: &str, callback: &JsValue) -> Promise;
    }
    let out: Rc<RefCell<Option<T>>> = Rc::new(RefCell::new(None));
    let slot = out.clone();
    let mut f = Some(f);
    // The lock is held until the promise the callback returns settles.
    let callback = Closure::once_into_js(move |_lock: JsValue| -> Promise {
        let f = f.take().expect("called once");
        wasm_bindgen_futures::future_to_promise(async move {
            *slot.borrow_mut() = Some(f.await);
            Ok(JsValue::UNDEFINED)
        })
    });
    let _ = JsFuture::from(locks_request(name, &callback)).await;
    // Bound first: a borrow in the tail expression would outlive `out`.
    let value = out.borrow_mut().take();
    value.expect("the lock callback ran")
}

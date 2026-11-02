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

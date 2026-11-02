//! Glue between Rust values and JavaScript ones.

use reader_core::civil_date::CivilDate;
use serde::{de::DeserializeOwned, Serialize};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

pub type Res<T> = Result<T, JsValue>;

/// Rust → JS as plain JSON-shaped values. The default serializer makes JS
/// `Map`s for maps, which `chrome.storage` cannot store; json_compatible
/// makes plain objects, the shape every Chrome API expects.
pub fn to_js<T: Serialize + ?Sized>(value: &T) -> Res<JsValue> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(Into::into)
}

pub fn from_js<T: DeserializeOwned>(value: JsValue) -> Res<T> {
    serde_wasm_bindgen::from_value(value).map_err(Into::into)
}

/// Await a Promise-returning binding: `Result<Promise, JsValue>` → value.
pub async fn wait(promise: Res<js_sys::Promise>) -> Res<JsValue> {
    JsFuture::from(promise?).await
}

pub fn now() -> i64 {
    js_sys::Date::now() as i64
}

/// The local calendar date of a timestamp (the browser knows the time zone).
pub fn local_date(ms: i64) -> CivilDate {
    let d = js_sys::Date::new(&JsValue::from_f64(ms as f64));
    CivilDate::new(d.get_full_year() as i32, d.get_month() + 1, d.get_date())
}

pub fn error(message: impl AsRef<str>) -> JsValue {
    js_sys::Error::new(message.as_ref()).into()
}

pub fn log_error(context: &str, e: &JsValue) {
    web_sys::console::error_2(&JsValue::from_str(context), e);
}

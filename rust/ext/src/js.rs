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

/// Local midnight today, as epoch ms: where "today's" to-do list starts.
pub fn today_start() -> i64 {
    let d = js_sys::Date::new_0();
    js_sys::Date::new_with_year_month_day(
        d.get_full_year(),
        d.get_month() as i32,
        d.get_date() as i32,
    )
    .get_time() as i64
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

#[wasm_bindgen]
extern "C" {
    // The global timers: a page's window and the service worker both have them.
    #[wasm_bindgen(js_name = setTimeout)]
    fn set_timeout(cb: &JsValue, ms: i32) -> i32;
    #[wasm_bindgen(js_name = clearTimeout)]
    fn clear_timeout(id: i32);
}

/// A timer that owns its callback: dropping it cancels the timer and frees the
/// callback, so one cleared early (every answer that beats its timeout) leaks
/// nothing. Keep it alive for as long as it may fire.
pub struct Timeout {
    id: i32,
    _callback: Closure<dyn FnMut()>,
}

impl Timeout {
    pub fn new(ms: i32, f: impl FnOnce() + 'static) -> Self {
        let mut f = Some(f);
        let callback = Closure::<dyn FnMut()>::new(move || {
            if let Some(f) = f.take() {
                f();
            }
        });
        let id = set_timeout(callback.as_ref(), ms);
        Self {
            id,
            _callback: callback,
        }
    }
}

impl Drop for Timeout {
    fn drop(&mut self) {
        // Before the callback is freed (fields drop after this), so it can never fire freed.
        clear_timeout(self.id);
    }
}

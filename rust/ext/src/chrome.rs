//! Bindings for the Chrome APIs this extension uses, as `wasm_bindgen`
//! externs: each line declares a JavaScript function Rust may call. MV3 APIs
//! return Promises; `catch` turns a synchronous throw (Chrome throws a
//! TypeError on bad arguments) into an `Err` instead of a wasm trap.

use js_sys::Promise;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch, js_namespace = ["chrome", "storage", "local"], js_name = get)]
    pub fn local_get(keys: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "storage", "local"], js_name = set)]
    pub fn local_set(items: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "storage", "local"], js_name = remove)]
    pub fn local_remove(keys: &JsValue) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["chrome", "storage", "session"], js_name = get)]
    pub fn session_get(keys: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "storage", "session"], js_name = set)]
    pub fn session_set(items: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "storage", "session"], js_name = remove)]
    pub fn session_remove(keys: &JsValue) -> Result<Promise, JsValue>;

    #[wasm_bindgen(js_namespace = ["chrome", "runtime"], js_name = getURL)]
    pub fn get_url(path: &str) -> String;

    #[wasm_bindgen(catch, js_namespace = ["chrome", "tabs"], js_name = query)]
    pub fn tabs_query(info: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "tabs"], js_name = update)]
    pub fn tabs_update(tab_id: i32, props: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "tabs"], js_name = get)]
    pub fn tabs_get(tab_id: i32) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "tabs"], js_name = create)]
    pub fn tabs_create(props: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "windows"], js_name = update)]
    pub fn windows_update(window_id: i32, props: &JsValue) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["chrome", "alarms"], js_name = create)]
    pub fn alarms_create(name: &str, info: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "alarms"], js_name = clear)]
    pub fn alarms_clear(name: &str) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "alarms"], js_name = getAll)]
    pub fn alarms_get_all() -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["chrome", "declarativeNetRequest"], js_name = getSessionRules)]
    pub fn dnr_get_session_rules() -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "declarativeNetRequest"], js_name = updateSessionRules)]
    pub fn dnr_update_session_rules(options: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "declarativeNetRequest"], js_name = getDynamicRules)]
    pub fn dnr_get_dynamic_rules() -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "declarativeNetRequest"], js_name = updateDynamicRules)]
    pub fn dnr_update_dynamic_rules(options: &JsValue) -> Result<Promise, JsValue>;

    #[wasm_bindgen(js_namespace = ["chrome", "identity"], js_name = getRedirectURL)]
    pub fn identity_redirect_url(path: &str) -> String;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "identity"], js_name = launchWebAuthFlow)]
    pub fn identity_launch_web_auth_flow(details: &JsValue) -> Result<Promise, JsValue>;

    /// The global `fetch`, the same in a page and in the service worker.
    #[wasm_bindgen(catch, js_name = fetch)]
    pub fn fetch(url: &str, init: &JsValue) -> Result<Promise, JsValue>;

    #[wasm_bindgen(js_namespace = crypto, js_name = randomUUID)]
    pub fn random_uuid() -> String;
    #[wasm_bindgen(js_namespace = crypto, js_name = getRandomValues)]
    pub fn get_random_values(buf: &mut [u8]);
}

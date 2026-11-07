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
    #[wasm_bindgen(catch, js_namespace = ["chrome", "runtime"], js_name = getContexts)]
    pub fn runtime_get_contexts(filter: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "tabs"], js_name = create)]
    pub fn tabs_create(props: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "tabs"], js_name = getCurrent)]
    pub fn tabs_get_current() -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "tabs"], js_name = remove)]
    pub fn tabs_remove(tab_id: i32) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "windows"], js_name = update)]
    pub fn windows_update(window_id: i32, props: &JsValue) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["chrome", "scripting"], js_name = executeScript)]
    pub fn scripting_execute_script(details: &JsValue) -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["chrome", "alarms"], js_name = create)]
    pub fn alarms_create(name: &str, info: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "alarms"], js_name = clear)]
    pub fn alarms_clear(name: &str) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "alarms"], js_name = getAll)]
    pub fn alarms_get_all() -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["chrome", "offscreen"], js_name = createDocument)]
    pub fn offscreen_create(params: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "offscreen"], js_name = closeDocument)]
    pub fn offscreen_close() -> Result<Promise, JsValue>;

    #[wasm_bindgen(catch, js_namespace = ["chrome", "notifications"], js_name = create)]
    pub fn notifications_create(id: &str, options: &JsValue) -> Result<Promise, JsValue>;

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

    #[wasm_bindgen(catch, js_namespace = ["chrome", "runtime"], js_name = sendMessage)]
    pub fn send_message(msg: &JsValue) -> Result<Promise, JsValue>;
    #[wasm_bindgen(catch, js_namespace = ["chrome", "runtime"], js_name = openOptionsPage)]
    pub fn open_options_page() -> Result<Promise, JsValue>;
    #[wasm_bindgen(js_namespace = ["chrome", "storage", "onChanged"], js_name = addListener)]
    pub fn on_storage_changed(listener: &Closure<dyn FnMut(JsValue, JsValue)>);
    #[wasm_bindgen(js_namespace = ["chrome", "tabs", "onActivated"], js_name = addListener)]
    pub fn tabs_on_activated(listener: &Closure<dyn FnMut(JsValue)>);
    #[wasm_bindgen(js_namespace = ["chrome", "tabs", "onUpdated"], js_name = addListener)]
    pub fn tabs_on_updated(listener: &Closure<dyn FnMut(i32, JsValue, JsValue)>);

    /// The global `fetch`, the same in a page and in the service worker.
    #[wasm_bindgen(catch, js_name = fetch)]
    pub fn fetch(url: &str, init: &JsValue) -> Result<Promise, JsValue>;

    #[wasm_bindgen(js_namespace = crypto, js_name = randomUUID)]
    pub fn random_uuid() -> String;
    #[wasm_bindgen(js_namespace = crypto, js_name = getRandomValues)]
    pub fn get_random_values(buf: &mut [u8]);
}

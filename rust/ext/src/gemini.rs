//! Gemini from a page: one generateContent call (reader_core::youtube builds
//! the request and reads the reply). Host permissions cover the API, so no
//! CORS dance.

use crate::chrome;
use crate::claude::{clear_timeout, gloo_timeout};
use crate::js::to_js;
use js_sys::Reflect;
use reader_core::youtube::{gemini_error, gemini_url};
use serde_json::{json, Value};
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

/// The raw reply body on success; the failure in words otherwise.
pub async fn generate(
    key: &str,
    body: &Value,
    timeout_ms: i32,
    controller: Option<web_sys::AbortController>,
) -> Result<String, String> {
    let controller = match controller {
        Some(c) => c,
        None => web_sys::AbortController::new().map_err(|_| "no AbortController")?,
    };
    let init = to_js(&json!({
        "method": "POST",
        "headers": { "content-type": "application/json", "x-goog-api-key": key },
        "body": body.to_string(),
    }))
    .map_err(|_| "request")?;
    Reflect::set(&init, &"signal".into(), &controller.signal()).map_err(|_| "signal")?;
    let abort = controller.clone();
    let timer = gloo_timeout(timeout_ms, move || abort.abort());
    let result = async {
        let res: web_sys::Response = JsFuture::from(
            chrome::fetch(&gemini_url(), &init).map_err(|_| "Could not reach Gemini.")?,
        )
        .await
        .map_err(|_| "Could not reach Gemini.")?
        .unchecked_into();
        let text = JsFuture::from(res.text().map_err(|_| "Gemini sent no body.")?)
            .await
            .ok()
            .and_then(|t| t.as_string())
            .unwrap_or_default();
        if res.ok() {
            Ok(text)
        } else {
            Err(gemini_error(res.status(), &text))
        }
    }
    .await;
    clear_timeout(timer);
    if controller.signal().aborted() && result.is_err() {
        return Err("Gemini took too long, or was stopped.".into());
    }
    result
}

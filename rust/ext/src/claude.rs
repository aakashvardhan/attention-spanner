//! Claude Haiku from a page, streamed (src/shared/llm/claude.ts). The
//! protocol is reader_core::claude; this reads the response body chunk by
//! chunk so text appears as it is written.

use crate::cache;
use crate::chrome;
use crate::js::to_js;
use js_sys::{Reflect, Uint8Array};
use reader_core::claude::{
    headers, parse_event, request_body, status_message, Event, SseBuffer, MESSAGES_URL,
};
use serde_json::json;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

pub struct Ask<'a> {
    pub api_key: &'a str,
    pub model: &'a str,
    pub system: &'a str,
    pub document: &'a str,
    pub prompt: &'a str,
    pub cache: bool,
    /// Give up after this long (the brain dump waits a minute)
    pub timeout_ms: i32,
    /// The caller's, to stop the answer early; one is made otherwise
    pub controller: Option<web_sys::AbortController>,
    /// A picture sent with the document (a PDF page as printed), base64 JPEG
    pub image_jpeg: Option<&'a str>,
    /// Keep the finished reply, and answer the same request from it next
    /// time (crate::cache). Only for replies that should not change.
    pub remember: bool,
}

/// The whole reply; `on_text` gets the text so far after every chunk.
pub async fn stream(ask: Ask<'_>, mut on_text: impl FnMut(&str)) -> Result<String, String> {
    let controller = match ask.controller {
        Some(c) => c,
        None => web_sys::AbortController::new().map_err(|_| "no AbortController")?,
    };
    let body = request_body(
        ask.model,
        ask.system,
        ask.document,
        ask.prompt,
        ask.cache,
        ask.image_jpeg,
    )
    .to_string();
    let key = ask.remember.then(|| cache::key(MESSAGES_URL, &body));
    if let Some(k) = &key {
        if let Some(text) = cache::CLAUDE.get_text(k).await {
            on_text(&text);
            return Ok(text);
        }
    }
    let init = to_js(&json!({
        "method": "POST",
        "headers": headers(ask.api_key),
        "body": body,
    }))
    .map_err(|_| "request")?;
    Reflect::set(&init, &"signal".into(), &controller.signal()).map_err(|_| "signal")?;
    let abort = controller.clone();
    let timer = gloo_timeout(ask.timeout_ms, move || abort.abort());

    let result = async {
        let res: web_sys::Response = JsFuture::from(
            chrome::fetch(MESSAGES_URL, &init).map_err(|_| "Could not reach Claude.")?,
        )
        .await
        .map_err(|_| "Could not reach Claude.")?
        .unchecked_into();
        if !res.ok() {
            return Err(status_message(res.status()).to_string());
        }
        let reader: web_sys::ReadableStreamDefaultReader = res
            .body()
            .ok_or("Claude sent no body.")?
            .get_reader()
            .unchecked_into();
        let decoder = web_sys::TextDecoder::new().map_err(|_| "decoder")?;
        let options = web_sys::TextDecodeOptions::new();
        options.set_stream(true);
        let mut buffer = SseBuffer::default();
        let mut text = String::new();
        loop {
            let chunk = JsFuture::from(reader.read())
                .await
                .map_err(|_| "Could not reach Claude.")?;
            if Reflect::get(&chunk, &"done".into())
                .ok()
                .and_then(|d| d.as_bool())
                .unwrap_or(true)
            {
                break;
            }
            let bytes: Uint8Array = Reflect::get(&chunk, &"value".into())
                .map_err(|_| "chunk")?
                .unchecked_into();
            let part = decoder
                .decode_with_js_u8_array_and_options(&bytes, &options)
                .map_err(|_| "decode")?;
            for data in buffer.push(&part) {
                match parse_event(&data) {
                    Event::Text(t) => {
                        text.push_str(&t);
                        on_text(&text);
                    }
                    Event::Refusal => return Err("Claude declined to answer this.".to_string()),
                    Event::Error(m) => return Err(m),
                    Event::Other => {}
                }
            }
        }
        Ok(text)
    }
    .await;
    clear_timeout(timer);
    // Only a whole reply: a stopped or failed one is asked again next time.
    if let (Some(k), Ok(text)) = (&key, &result) {
        cache::CLAUDE.put_text(k, text).await;
    }
    result
}

#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    // The global timers: a page's window and the service worker both have them.
    #[wasm_bindgen(js_name = setTimeout)]
    fn set_timeout(cb: &wasm_bindgen::JsValue, ms: i32) -> i32;
    #[wasm_bindgen(js_name = clearTimeout)]
    fn clear_timeout_js(id: i32);
}

pub(crate) fn gloo_timeout(ms: i32, f: impl FnOnce() + 'static) -> i32 {
    set_timeout(&wasm_bindgen::closure::Closure::once_into_js(f), ms)
}

pub(crate) fn clear_timeout(id: i32) {
    clear_timeout_js(id);
}

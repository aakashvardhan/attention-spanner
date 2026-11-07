//! Answers kept in the browser's Cache API, so asking the same thing twice
//! (listening to a page again) costs nothing: no request, no rate limit, no
//! wait. The key is the request body's hash under the provider's URL, so a
//! different model, voice, prompt or page is a different entry. API keys sit
//! in headers and never reach the key.

use js_sys::{Array, Uint8Array};
use std::hash::{DefaultHasher, Hash, Hasher};
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

/// Speech: a few seconds of audio each, ~0.1-0.6 MB.
pub const SPEECH: Store = Store {
    name: "speech-v1",
    max: 400,
};
/// Haiku replies: text, small.
pub const CLAUDE: Store = Store {
    name: "claude-v1",
    max: 1000,
};

pub struct Store {
    name: &'static str,
    /// Oldest entries go once there are more than this.
    max: u32,
}

/// The cache key for a request. It must be http(s) (the Cache API refuses
/// anything else) and the hash goes in the query (matching ignores `#`).
/// ponytail: 64-bit SipHash; a Rust upgrade may change it, which only
/// empties the cache once.
pub fn key(url: &str, body: &str) -> String {
    let mut h = DefaultHasher::new();
    body.hash(&mut h);
    format!("{url}?k={:016x}", h.finish())
}

impl Store {
    async fn open(&self) -> Option<web_sys::Cache> {
        let caches = web_sys::window()?.caches().ok()?;
        JsFuture::from(caches.open(self.name))
            .await
            .ok()
            .map(JsCast::unchecked_into)
    }

    async fn get(&self, key: &str) -> Option<web_sys::Response> {
        let hit = JsFuture::from(self.open().await?.match_with_str(key))
            .await
            .ok()?;
        hit.dyn_into().ok()
    }

    pub async fn get_bytes(&self, key: &str) -> Option<js_sys::ArrayBuffer> {
        let res = self.get(key).await?;
        let buf = JsFuture::from(res.array_buffer().ok()?).await.ok()?;
        Some(buf.unchecked_into())
    }

    pub async fn get_text(&self, key: &str) -> Option<String> {
        let res = self.get(key).await?;
        JsFuture::from(res.text().ok()?).await.ok()?.as_string()
    }

    /// Copies the bytes: the caller keeps (and may detach) its buffer.
    pub async fn put_bytes(&self, key: &str, buf: &js_sys::ArrayBuffer) {
        let copy = Uint8Array::new(buf);
        if let Ok(res) = web_sys::Response::new_with_opt_buffer_source(Some(&copy)) {
            self.put(key, &res).await;
        }
    }

    pub async fn put_text(&self, key: &str, text: &str) {
        if let Ok(res) = web_sys::Response::new_with_opt_str(Some(text)) {
            self.put(key, &res).await;
        }
    }

    /// Best effort: a full disk or a closed page only means a miss later.
    async fn put(&self, key: &str, res: &web_sys::Response) {
        let Some(cache) = self.open().await else {
            return;
        };
        if JsFuture::from(cache.put_with_str(key, res)).await.is_err() {
            return;
        }
        // keys() lists in the order entries were added: drop from the front.
        let Ok(keys) = JsFuture::from(cache.keys()).await else {
            return;
        };
        let keys: Array = keys.unchecked_into();
        let extra = keys.length().saturating_sub(self.max);
        for i in 0..extra {
            let req: web_sys::Request = keys.get(i).unchecked_into();
            let _ = JsFuture::from(cache.delete_with_request(&req)).await;
        }
    }
}

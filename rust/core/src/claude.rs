//! The Claude Messages API, streaming (src/shared/llm/claude.ts), the pure
//! half: the request body, cutting a byte stream into server-sent events as
//! chunks arrive, and reading each event.

use serde_json::{json, Value};

pub const MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
pub const API_VERSION: &str = "2023-06-01";

/// The streamed request. With `cache`, the document sits in its own block
/// cached for an hour, so a second question about the same paper reads it
/// from the prompt cache. `image` (base64 JPEG) goes first, before the text.
pub fn request_body(
    model: &str,
    system: &str,
    document: &str,
    prompt: &str,
    cache: bool,
    image: Option<&str>,
) -> Value {
    let mut doc = json!({ "type": "text", "text": document });
    if cache {
        doc["cache_control"] = json!({ "type": "ephemeral", "ttl": "1h" });
    }
    let mut content = Vec::new();
    if let Some(data) = image {
        content.push(json!({ "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": data } }));
    }
    content.push(doc);
    content.push(json!({ "type": "text", "text": prompt }));
    json!({
        "model": model,
        "max_tokens": 8000,
        "stream": true,
        "system": system,
        "messages": [{ "role": "user", "content": content }]
    })
}

/// The headers, including the one that allows a key in a browser context.
pub fn headers(api_key: &str) -> Value {
    json!({
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": API_VERSION,
        "anthropic-dangerous-direct-browser-access": "true"
    })
}

/// Server-sent events arrive split at arbitrary byte boundaries; this keeps
/// the unfinished tail and hands back each complete event's data.
#[derive(Debug, Default)]
pub struct SseBuffer {
    pending: String,
}

impl SseBuffer {
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.pending.push_str(&chunk.replace("\r\n", "\n"));
        let mut events = Vec::new();
        while let Some(end) = self.pending.find("\n\n") {
            let event: String = self.pending.drain(..end + 2).collect();
            let data: Vec<&str> = event
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect();
            if !data.is_empty() {
                events.push(data.join("\n"));
            }
        }
        events
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Text(String),
    /// The model declined to answer
    Refusal,
    Error(String),
    Other,
}

pub fn parse_event(data: &str) -> Event {
    let Ok(v) = serde_json::from_str::<Value>(data) else {
        return Event::Other;
    };
    match v["type"].as_str() {
        Some("content_block_delta") if v["delta"]["type"] == "text_delta" => {
            Event::Text(v["delta"]["text"].as_str().unwrap_or("").to_string())
        }
        Some("message_delta") if v["delta"]["stop_reason"] == "refusal" => Event::Refusal,
        Some("error") => Event::Error(
            v["error"]["message"]
                .as_str()
                .unwrap_or("Claude failed.")
                .to_string(),
        ),
        _ => Event::Other,
    }
}

/// What to tell the reader for a failed request.
pub fn status_message(status: u16) -> &'static str {
    match status {
        401 | 403 => "Claude rejected the API key.",
        429 => "Claude is rate-limiting this key. Try again shortly.",
        _ => "Claude could not answer this time.",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_streamed_request_caching_the_document_when_asked() {
        let b = request_body("claude-haiku-5-5", "sys", "doc", "q", false, None);
        assert_eq!(
            (b["stream"].as_bool(), b["system"].as_str()),
            (Some(true), Some("sys"))
        );
        assert_eq!(b["messages"][0]["content"][1]["text"], "q");
        assert!(b["messages"][0]["content"][0]
            .get("cache_control")
            .is_none());
        let cached = request_body("m", "s", "d", "q", true, None);
        let seen = request_body("m", "s", "d", "q", false, Some("AAAA"));
        assert_eq!(
            seen["messages"][0]["content"][0]["source"]["media_type"],
            "image/jpeg"
        );
        assert_eq!(seen["messages"][0]["content"][2]["text"], "q");
        assert_eq!(
            cached["messages"][0]["content"][0]["cache_control"]["ttl"],
            "1h"
        );
        assert_eq!(
            headers("k")["anthropic-dangerous-direct-browser-access"],
            "true"
        );
    }

    #[test]
    fn cuts_events_across_any_chunk_boundary() {
        let stream = "event: content_block_delta\ndata: {\"a\":1}\n\nevent: x\ndata: {\"b\":2}\n\n";
        for cut in 0..stream.len() {
            let mut buf = SseBuffer::default();
            let mut got = buf.push(&stream[..cut]);
            got.extend(buf.push(&stream[cut..]));
            assert_eq!(got, ["{\"a\":1}", "{\"b\":2}"], "cut at {cut}");
        }
        assert_eq!(SseBuffer::default().push("data: x\r\n\r\n"), ["x"]);
    }

    #[test]
    fn reads_text_refusals_and_errors() {
        assert_eq!(
            parse_event(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}"#
            ),
            Event::Text("hi".into())
        );
        assert_eq!(
            parse_event(r#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#),
            Event::Refusal
        );
        assert_eq!(
            parse_event(r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#),
            Event::Other
        );
        assert_eq!(
            parse_event(
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
            ),
            Event::Error("Overloaded".into())
        );
        assert_eq!(parse_event("not json"), Event::Other);
        assert_eq!(status_message(401), "Claude rejected the API key.");
    }
}

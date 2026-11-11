//! A minimal MCP client core: JSON-RPC 2.0 over Streamable HTTP, the pure
//! half. The worker POSTs these bodies and hands the response back here. Two
//! reply forms are allowed by the spec: one JSON message, or a server-sent
//! event stream whose `data:` lines carry messages (notifications first,
//! perhaps, then the reply with our `id`).

use serde_json::{json, Value};

pub const PROTOCOL_VERSION: &str = "2025-06-18";
pub const SESSION_HEADER: &str = "mcp-session-id";
pub const VERSION_HEADER: &str = "mcp-protocol-version";
pub const ACCEPT: &str = "application/json, text/event-stream";

pub fn initialize(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "adhd-reader", "version": "1.0.0" }
        }
    })
}

/// Sent after a successful initialize; a notification has no id and no reply.
pub fn initialized() -> Value {
    json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
}

pub fn tool_call(id: u64, name: &str, arguments: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": arguments } })
}

#[derive(Debug, Clone, PartialEq)]
pub enum ReplyError {
    /// No message with our id in the body
    Missing,
    /// The server answered with a JSON-RPC error
    Rpc { code: i64, message: String },
}

/// The `result` of the message answering `id`, from a JSON or SSE body.
pub fn parse_reply(content_type: &str, body: &str, id: u64) -> Result<Value, ReplyError> {
    let messages: Vec<Value> = if content_type.starts_with("text/event-stream") {
        sse_data(body)
            .iter()
            .filter_map(|d| serde_json::from_str(d).ok())
            .collect()
    } else {
        match serde_json::from_str(body) {
            Ok(Value::Array(batch)) => batch,
            Ok(one) => vec![one],
            Err(_) => vec![],
        }
    };
    let reply = messages
        .into_iter()
        .find(|m| m.get("id").and_then(Value::as_u64) == Some(id))
        .ok_or(ReplyError::Missing)?;
    if let Some(e) = reply.get("error") {
        return Err(ReplyError::Rpc {
            code: e.get("code").and_then(Value::as_i64).unwrap_or(0),
            message: e
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

/// The `data` of each SSE event: consecutive `data:` lines joined by newlines,
/// events separated by a blank line (the HTML spec's rules, minus retry/id).
pub(crate) fn sse_data(body: &str) -> Vec<String> {
    let mut events = Vec::new();
    let mut data: Vec<&str> = Vec::new();
    for line in body.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if !data.is_empty() {
                events.push(data.join("\n"));
                data.clear();
            }
        } else if let Some(rest) = line.strip_prefix("data:") {
            data.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    events
}

/// A `tools/call` result as (text, is_error): every text block joined.
pub fn tool_text(result: &Value) -> (String, bool) {
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default();
    (
        text,
        result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_three_requests() {
        assert_eq!(initialize(1)["params"]["protocolVersion"], PROTOCOL_VERSION);
        assert!(initialized().get("id").is_none());
        let call = tool_call(7, "list_library", &json!({ "include_papers": true }));
        assert_eq!(
            (call["id"].as_u64(), call["method"].as_str()),
            (Some(7), Some("tools/call"))
        );
        assert_eq!(call["params"]["arguments"]["include_papers"], true);
    }

    #[test]
    fn reads_a_plain_json_reply_or_a_batch() {
        let body = r#"{"jsonrpc":"2.0","id":3,"result":{"ok":1}}"#;
        assert_eq!(
            parse_reply("application/json", body, 3),
            Ok(json!({ "ok": 1 }))
        );
        let batch =
            r#"[{"jsonrpc":"2.0","method":"notifications/x"},{"jsonrpc":"2.0","id":3,"result":2}]"#;
        assert_eq!(
            parse_reply("application/json; charset=utf-8", batch, 3),
            Ok(json!(2))
        );
    }

    #[test]
    fn reads_an_sse_stream_skipping_notifications_and_other_ids() {
        let body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n\
                    data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"old\"}\n\n\
                    event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":5,\n\
                    data: \"result\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n";
        assert_eq!(
            parse_reply("text/event-stream", body, 5),
            Ok(json!({ "content": [{ "type": "text", "text": "hi" }] }))
        );
    }

    #[test]
    fn a_json_rpc_error_or_no_reply_is_an_error() {
        let body = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Unknown tool"}}"#;
        assert_eq!(
            parse_reply("application/json", body, 1),
            Err(ReplyError::Rpc {
                code: -32602,
                message: "Unknown tool".into()
            })
        );
        assert_eq!(
            parse_reply("application/json", "", 1),
            Err(ReplyError::Missing)
        );
        assert_eq!(
            parse_reply("text/event-stream", "data: {\"id\":9}\n\n", 1),
            Err(ReplyError::Missing)
        );
    }

    #[test]
    fn tool_text_joins_text_blocks_and_reports_is_error() {
        let r = json!({ "content": [{ "type": "text", "text": "a" }, { "type": "image" }, { "type": "text", "text": "b" }] });
        assert_eq!(tool_text(&r), ("ab".to_string(), false));
        assert_eq!(
            tool_text(
                &json!({ "content": [{ "type": "text", "text": "Paper not found" }], "isError": true })
            ),
            ("Paper not found".to_string(), true)
        );
        assert_eq!(tool_text(&json!({})), (String::new(), false));
    }
}

//! The side panel's Haiku and Gemini requests, exactly as the extension builds
//! them, for the agentic evals (eval/sidebar/run.mjs, eval/youtube/run.mjs).
//! Reads tasks as JSON on stdin, writes `[{ id, model, body }]` on stdout: the
//! model too, so the runners never keep a copy of it that could drift.
//!
//! A task: `{ "id", "kind": "listen" | "talk" | "notes" | "video-talk", "title", "sections": [..], "url"?, "force"?, "at"?,
//! "n"?: section to narrate (1-based), "history"?: [{ "agent", "text" }] }`.

use reader_core::audiobook::{narrate_prompt, narrate_system, page_document};
use reader_core::claude::request_body;
use reader_core::constants::CLAUDE_MODEL_QUICK;
use reader_core::voice_agent::{agent_system, paper_document, turn_prompt, Source, Turn};
use reader_core::youtube::GEMINI_MODEL;
use serde_json::{json, Value};
use std::io::Read;

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("stdin");
    let tasks: Vec<Value> = serde_json::from_str(&input).expect("tasks JSON");
    let out: Vec<Value> = tasks.iter().map(build).collect();
    println!("{}", serde_json::to_string_pretty(&out).expect("json"));
}

fn build(t: &Value) -> Value {
    let title = t["title"].as_str().unwrap_or_default();
    let sections: Vec<String> = t["sections"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| s.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let (model, body) = match t["kind"].as_str() {
        Some("listen") => {
            let n = t["n"].as_u64().unwrap_or(1) as usize;
            assert!(
                (1..=sections.len()).contains(&n),
                "task {}: n = {n} is not one of its {} sections",
                t["id"],
                sections.len()
            );
            let previous = (n > 1).then(|| sections[n - 2].as_str());
            let body = request_body(
                CLAUDE_MODEL_QUICK,
                &narrate_system(title, Source::Webpage),
                &page_document(&sections[n - 1]),
                &narrate_prompt(n as u32, sections.len() as u32, previous, Source::Webpage),
                false,
                None,
            );
            (CLAUDE_MODEL_QUICK, body)
        }
        Some("talk") => {
            let body = request_body(
                CLAUDE_MODEL_QUICK,
                &agent_system(title, Source::Webpage),
                &paper_document(&sections, Source::Webpage),
                &turn_prompt(&history(t), 1, Source::Webpage),
                true,
                None,
            );
            (CLAUDE_MODEL_QUICK, body)
        }
        Some("notes") => {
            let kind = t["force"]
                .as_str()
                .and_then(|k| serde_json::from_value(json!(k)).ok());
            let url = t["url"].as_str().unwrap_or_default();
            (
                GEMINI_MODEL,
                reader_core::youtube::notes_request(url, kind, None),
            )
        }
        Some("video-talk") => {
            let body = reader_core::youtube::talk_request(
                &agent_system(title, Source::Video),
                &paper_document(&sections, Source::Video),
                &turn_prompt(
                    &history(t),
                    t["at"].as_u64().unwrap_or(0) as u32,
                    Source::Video,
                ),
            );
            (GEMINI_MODEL, body)
        }
        other => panic!("unknown kind {other:?}"),
    };
    json!({ "id": t["id"], "model": model, "body": body })
}

/// A task's `history`: the turns so far.
fn history(t: &Value) -> Vec<Turn> {
    t["history"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|h| Turn {
                    agent: h["agent"].as_bool().unwrap_or(false),
                    text: h["text"].as_str().unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

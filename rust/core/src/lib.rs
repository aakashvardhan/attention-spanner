//! The extension's rules, as pure Rust: no `wasm_bindgen`, no `web_sys`, no
//! Chrome. Everything here runs (and is tested) natively with `cargo test`,
//! which is the quickest loop for learning the language. The `ext` crate does
//! the effects (storage, network, DOM) and calls in here for every decision.

pub mod activity;
pub mod ai;
pub mod alphaxiv;
pub mod annotations;
pub mod audiobook;
pub mod brain_dump;
pub mod civil_date;
pub mod claude;
pub mod clicked_word;
pub mod constants;
pub mod explain;
pub mod feed;
pub mod figures;
pub mod find;
pub mod focus_rules;
pub mod format;
pub mod game;
pub mod graph_layout;
pub mod lexicon;
pub mod markdown;
pub mod mcp;
pub mod messages;
pub mod migrations;
pub mod outline;
pub mod papers;
pub mod pdf;
pub mod pomodoro;
pub mod questions;
pub mod reader_progress;
pub mod reading_aids;
pub mod recolor;
pub mod shelf;
pub mod todos;
pub mod types;
pub mod vault;
pub mod voice;
pub mod voice_agent;
pub mod webpage;
pub mod youtube;

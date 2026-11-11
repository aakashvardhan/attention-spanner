//! A tab's main text for the side panel: `page-text.js` runs in the tab and
//! returns blocks (math as LaTeX); core cuts them into sections.

use crate::chrome;
use crate::js::{from_js, to_js, wait};
use reader_core::webpage::{sections, Block};
use serde::Deserialize;
use serde_json::json;

pub const UNREADABLE: &str = "This page can't be read here.";
const NO_TEXT: &str = "Couldn't find any text on this page.";

#[derive(Debug, Clone, PartialEq)]
pub struct PageText {
    pub title: String,
    pub sections: Vec<String>,
}

#[derive(Deserialize)]
struct Injected {
    result: Option<Extracted>,
}

#[derive(Deserialize)]
struct Extracted {
    title: String,
    blocks: Vec<Block>,
}

/// Reads the tab. Pages Chrome won't inject into (chrome://, the Web Store,
/// other extensions) are `UNREADABLE`; a page with no body text is `NO_TEXT`.
pub async fn read(tab_id: i32) -> Result<PageText, String> {
    let details = to_js(&json!({ "target": { "tabId": tab_id }, "files": ["page-text.js"] }))
        .map_err(|_| UNREADABLE.to_string())?;
    let results: Vec<Injected> = wait(chrome::scripting_execute_script(&details))
        .await
        .and_then(from_js)
        .map_err(|_| UNREADABLE.to_string())?;
    let page = results
        .into_iter()
        .next()
        .and_then(|r| r.result)
        .ok_or_else(|| UNREADABLE.to_string())?;
    let sections = sections(&page.blocks);
    if sections.is_empty() {
        return Err(NO_TEXT.into());
    }
    Ok(PageText {
        title: page.title,
        sections,
    })
}

//! arXiv PDFs into the reader (src/background/pdfIntercept.ts).

use crate::chrome;
use crate::js::{from_js, to_js, wait, Res};
use crate::store;
use reader_core::constants::{MAX_PDF_NATIVE_BYPASS, READER_PAGE_PATH};
use reader_core::pdf::{bypass_rule, is_pdf_rule, reader_redirect_rule};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct Rule {
    id: i64,
}

/// The redirect and every bypass, rebuilt atomically on each worker start.
pub async fn sync_pdf_rules() -> Res<()> {
    let bypass: Vec<String> = store::session_get("pdfNativeBypass").await?;
    let existing: Vec<Rule> = from_js(wait(chrome::dnr_get_session_rules()).await?)?;
    let remove: Vec<i64> = existing
        .iter()
        .map(|r| r.id)
        .filter(|id| is_pdf_rule(*id))
        .collect();
    let mut add = vec![reader_redirect_rule(&chrome::get_url(READER_PAGE_PATH))];
    add.extend(
        bypass
            .iter()
            .enumerate()
            .map(|(i, url)| bypass_rule(url, i)),
    );
    wait(chrome::dnr_update_session_rules(&to_js(
        &json!({ "removeRuleIds": remove, "addRules": add }),
    )?))
    .await
    .map(drop)
}

/// "Open in Chrome's viewer": remember the URL for the session, then go there.
pub async fn open_native_pdf(tab_id: i32, url: &str) -> Res<()> {
    let mut bypass: Vec<String> = store::session_get("pdfNativeBypass").await?;
    if !bypass.iter().any(|u| u == url) {
        bypass.push(url.to_string());
        // Oldest first out: it is the least likely to be revisited.
        let excess = bypass.len().saturating_sub(MAX_PDF_NATIVE_BYPASS);
        bypass.drain(..excess);
        store::session_set("pdfNativeBypass", &bypass).await?;
    }
    sync_pdf_rules().await?;
    wait(chrome::tabs_update(tab_id, &to_js(&json!({ "url": url }))?))
        .await
        .map(drop)
}

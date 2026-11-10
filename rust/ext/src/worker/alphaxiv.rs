//! alphaXiv, the network half: sign-in (OAuth
//! 2.1 with PKCE, a public client registered on first use), an MCP session
//! over Streamable HTTP, and the library sync. Every rule is in
//! reader_core::alphaxiv / ::mcp; this file only moves bytes.

use crate::chrome;
use crate::js::{from_js, now, to_js, wait, Res};
use crate::store;
use js_sys::Promise;
use reader_core::alphaxiv::{
    auth_from_token_reply, authorize_url, base64url, code_from_redirect, error_message, folder_key,
    kind_for_status, merge_library, needs_refresh, parse_feed, parse_folder_id, parse_library,
    pkce_challenge, plan_push, AlphaxivAuth, AlphaxivError, AlphaxivStatus, ErrorKind, PushItem,
    MCP_URL, REGISTER_URL, REVOKE_URL, SCOPE, TOKEN_URL, USERINFO_URL,
};
use reader_core::constants::SYNC_ALARM;
use reader_core::mcp;
use reader_core::shelf;
use reader_core::types::{Folder, Paper};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::{future_to_promise, JsFuture};

/// A sync within this window of the last is skipped unless forced.
const SYNC_MIN_GAP_MS: i64 = 2 * 60_000;

type AxResult<T> = Result<T, AlphaxivError>;

fn offline() -> AlphaxivError {
    AlphaxivError::new(ErrorKind::Offline, error_message(ErrorKind::Offline))
}

/* ---------- HTTP ---------- */

struct Http {
    status: u16,
    content_type: String,
    session_id: Option<String>,
    body: String,
}

/// One fetch. A rejected fetch (no network, DNS) is `Offline`.
async fn http(url: &str, method: &str, headers: Value, body: Option<String>) -> AxResult<Http> {
    // No cookies: alphaXiv's CSRF check answers 403 "Invalid origin" to any
    // cookie-carrying request from an extension origin. Auth here is the bearer token.
    let init = to_js(
        &json!({ "method": method, "headers": headers, "body": body, "credentials": "omit" }),
    )
    .map_err(|_| offline())?;
    let res: web_sys::Response = wait(chrome::fetch(url, &init))
        .await
        .map_err(|_| offline())?
        .unchecked_into();
    let header = |name: &str| res.headers().get(name).ok().flatten();
    let text = JsFuture::from(res.text().map_err(|_| offline())?)
        .await
        .map_err(|_| offline())?;
    Ok(Http {
        status: res.status(),
        content_type: header("content-type").unwrap_or_default(),
        session_id: header(mcp::SESSION_HEADER),
        body: text.as_string().unwrap_or_default(),
    })
}

fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

async fn post_form(url: &str, pairs: &[(&str, &str)]) -> AxResult<Value> {
    let r = http(url, "POST", json!({ "content-type": "application/x-www-form-urlencoded", "accept": "application/json" }), Some(form(pairs))).await?;
    if !(200..300).contains(&r.status) {
        // 400 from the token endpoint is invalid_grant: the session is over.
        let kind = if r.status == 400 {
            ErrorKind::SignedOut
        } else {
            kind_for_status(r.status)
        };
        return Err(AlphaxivError::new(
            kind,
            format!("alphaXiv refused ({}).", r.status),
        ));
    }
    serde_json::from_str(&r.body).map_err(|_| {
        AlphaxivError::new(
            ErrorKind::Failed,
            "alphaXiv sent a token reply that is not JSON.",
        )
    })
}

/* ---------- Sign-in ---------- */

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientRecord {
    client_id: String,
    redirect_uri: String,
}

/// alphaXiv's own words for a refusal: its JSON `message`/`error`, a note
/// when Cloudflare answered with a page instead, else the start of the body.
fn refusal_reason(r: &Http) -> String {
    if r.content_type.contains("text/html") {
        return "Cloudflare blocked the request; open alphaxiv.org in this browser, then try again.".into();
    }
    let v: Value = serde_json::from_str(&r.body).unwrap_or_default();
    ["message", "error_description", "error"]
        .iter()
        .find_map(|k| v[*k].as_str().map(str::to_string))
        .unwrap_or_else(|| r.body.chars().take(160).collect())
}

/// A client id for this redirect URI: reused while the extension id holds.
async fn client_for(redirect_uri: &str) -> AxResult<String> {
    let stored: Option<ClientRecord> = store::get("alphaxivClient").await.map_err(|_| offline())?;
    if let Some(c) = stored.filter(|c| c.redirect_uri == redirect_uri) {
        return Ok(c.client_id);
    }
    let body = json!({
        "client_name": "Reader",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": SCOPE,
    });
    let r = http(
        REGISTER_URL,
        "POST",
        json!({ "content-type": "application/json" }),
        Some(body.to_string()),
    )
    .await?;
    let id = serde_json::from_str::<Value>(&r.body)
        .ok()
        .and_then(|v| v["client_id"].as_str().map(str::to_string));
    let id = id
        .filter(|_| (200..300).contains(&r.status))
        .ok_or_else(|| {
            AlphaxivError::new(
                ErrorKind::Failed,
                format!(
                    "alphaXiv would not register this extension ({}): {}",
                    r.status,
                    refusal_reason(&r)
                ),
            )
        })?;
    let _ = store::set(
        "alphaxivClient",
        &ClientRecord {
            client_id: id.clone(),
            redirect_uri: redirect_uri.into(),
        },
    )
    .await;
    Ok(id)
}

fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    chrome::get_random_values(&mut buf);
    base64url(&buf)
}

async fn email_for(auth: &AlphaxivAuth) -> String {
    let headers = json!({ "authorization": format!("Bearer {}", auth.access_token) });
    match http(USERINFO_URL, "GET", headers, None).await {
        Ok(r) if r.status == 200 => serde_json::from_str::<Value>(&r.body)
            .ok()
            .and_then(|v| v["email"].as_str().map(str::to_string))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

async fn patch_status(f: impl FnOnce(&mut AlphaxivStatus)) {
    let mut status: AlphaxivStatus = store::get("alphaxivStatus").await.unwrap_or_default();
    f(&mut status);
    let _ = store::set("alphaxivStatus", &status).await;
}

/// Opens alphaXiv's own login window; resolves once signed in and synced.
pub async fn sign_in() -> Value {
    match sign_in_inner().await {
        Ok(()) => json!({ "ok": true }),
        Err(e) => {
            let message = e.message.clone();
            patch_status(|s| s.error = message.clone()).await;
            json!({ "ok": false, "error": message })
        }
    }
}

async fn sign_in_inner() -> AxResult<()> {
    let redirect_uri = chrome::identity_redirect_url("alphaxiv");
    let client_id = client_for(&redirect_uri).await?;
    let verifier = random_token(32);
    let state = random_token(16);
    let url = authorize_url(
        &client_id,
        &redirect_uri,
        &state,
        &pkce_challenge(&verifier),
    );
    let details = to_js(&json!({ "url": url, "interactive": true })).map_err(|_| offline())?;
    let redirect = match wait(chrome::identity_launch_web_auth_flow(&details)).await {
        Ok(v) => v.as_string().unwrap_or_default(),
        Err(e) => {
            let msg = e
                .dyn_ref::<js_sys::Error>()
                .map(|e| String::from(e.message()))
                .unwrap_or_default();
            // Closing the window is a choice, not a failure (Chrome's wording first).
            let cancelled = ["did not approve", "closed", "cancel"]
                .iter()
                .any(|w| msg.to_lowercase().contains(w));
            return Err(AlphaxivError::new(
                ErrorKind::SignedOut,
                if cancelled {
                    "Sign-in was cancelled.".to_string()
                } else {
                    msg
                },
            ));
        }
    };
    let code = code_from_redirect(&redirect, &state)
        .map_err(|m| AlphaxivError::new(ErrorKind::SignedOut, m))?;
    let reply = post_form(
        TOKEN_URL,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect_uri),
            ("client_id", &client_id),
            ("code_verifier", &verifier),
            ("resource", MCP_URL),
        ],
    )
    .await?;
    let auth = auth_from_token_reply(&reply, &client_id, &redirect_uri, None, now())?;
    let email = email_for(&auth).await;
    let _ = store::set("alphaxivAuth", &auth).await;
    let _ = store::set(
        "alphaxivStatus",
        &AlphaxivStatus {
            email,
            last_sync_at: None,
            error: String::new(),
        },
    )
    .await;
    let _ = wait(chrome::alarms_create(
        SYNC_ALARM,
        &to_js(&json!({ "periodInMinutes": 30 })).unwrap_or(JsValue::NULL),
    ))
    .await;
    sync(true).await;
    Ok(())
}

pub async fn sign_out() -> Res<Value> {
    let auth: Option<AlphaxivAuth> = store::get("alphaxivAuth").await?;
    store::set("alphaxivAuth", &Value::Null).await?;
    store::set("alphaxivStatus", &AlphaxivStatus::default()).await?;
    SESSION.with(|s| s.borrow_mut().take());
    let _ = wait(chrome::alarms_clear(SYNC_ALARM)).await;
    // Best effort: the local copy is already gone, which is what signing out means here.
    if let Some(a) = auth.filter(|a| !a.refresh_token.is_empty()) {
        wasm_bindgen_futures::spawn_local(async move {
            let _ = http(
                REVOKE_URL,
                "POST",
                json!({ "content-type": "application/x-www-form-urlencoded" }),
                Some(form(&[
                    ("token", &a.refresh_token),
                    ("client_id", &a.client_id),
                ])),
            )
            .await;
        });
    }
    Ok(json!({ "ok": true }))
}

/* ---------- Tokens ---------- */

thread_local! {
    /// The refresh in flight. A rotated refresh token is single-use, so a
    /// second caller awaits this promise instead of refreshing again.
    static REFRESHING: RefCell<Option<Promise>> = const { RefCell::new(None) };
    /// The MCP session: the token it was opened with, and the server's session id.
    static SESSION: RefCell<Option<(String, Option<String>)>> = const { RefCell::new(None) };
    static NEXT_ID: Cell<u64> = const { Cell::new(1) };
    /// The sync in flight, for the same reason.
    static SYNCING: RefCell<Option<Promise>> = const { RefCell::new(None) };
}

async fn current_auth(force: bool) -> AxResult<AlphaxivAuth> {
    let auth: Option<AlphaxivAuth> = store::get("alphaxivAuth").await.map_err(|_| offline())?;
    let auth = auth.ok_or_else(|| {
        AlphaxivError::new(ErrorKind::SignedOut, error_message(ErrorKind::SignedOut))
    })?;
    if !force && !needs_refresh(&auth, now()) {
        return Ok(auth);
    }
    if auth.refresh_token.is_empty() {
        let _ = store::set("alphaxivAuth", &Value::Null).await;
        return Err(AlphaxivError::new(
            ErrorKind::SignedOut,
            error_message(ErrorKind::SignedOut),
        ));
    }
    let promise = REFRESHING.with(|r| {
        r.borrow_mut()
            .get_or_insert_with(|| {
                future_to_promise(async move {
                    let result = refresh(auth).await;
                    REFRESHING.with(|r| r.borrow_mut().take());
                    match result {
                        Ok(a) => to_js(&a),
                        Err(e) => Err(to_js(
                            &json!({ "kind": format!("{:?}", e.kind), "message": e.message }),
                        )
                        .unwrap_or(JsValue::NULL)),
                    }
                })
            })
            .clone()
    });
    match JsFuture::from(promise).await {
        Ok(v) => from_js(v).map_err(|_| {
            AlphaxivError::new(ErrorKind::Failed, "Could not read the refreshed token.")
        }),
        Err(v) => {
            let e: Value = from_js(v).unwrap_or_default();
            let kind = if e["kind"] == "Offline" {
                ErrorKind::Offline
            } else if e["kind"] == "SignedOut" {
                ErrorKind::SignedOut
            } else {
                ErrorKind::Failed
            };
            Err(AlphaxivError::new(
                kind,
                e["message"].as_str().unwrap_or(""),
            ))
        }
    }
}

async fn refresh(auth: AlphaxivAuth) -> AxResult<AlphaxivAuth> {
    let reply = post_form(
        TOKEN_URL,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &auth.refresh_token),
            ("client_id", &auth.client_id),
            ("resource", MCP_URL),
        ],
    )
    .await;
    match reply {
        Ok(json) => {
            let next = auth_from_token_reply(
                &json,
                &auth.client_id,
                &auth.redirect_uri,
                Some(&auth.refresh_token),
                now(),
            )?;
            let _ = store::set("alphaxivAuth", &next).await;
            Ok(next)
        }
        Err(e) => {
            // Refused (not merely offline): the session is over; say so instead of retrying forever.
            if e.kind == ErrorKind::SignedOut {
                let _ = store::set("alphaxivAuth", &Value::Null).await;
            }
            Err(e)
        }
    }
}

/* ---------- MCP ---------- */

fn next_id() -> u64 {
    NEXT_ID.with(|n| {
        let id = n.get();
        n.set(id + 1);
        id
    })
}

fn mcp_headers(token: &str, session_id: Option<&str>) -> Value {
    let mut h = json!({ "authorization": format!("Bearer {token}"), "content-type": "application/json", "accept": mcp::ACCEPT });
    if let Some(id) = session_id {
        h[mcp::SESSION_HEADER] = json!(id);
        h[mcp::VERSION_HEADER] = json!(mcp::PROTOCOL_VERSION);
    }
    h
}

fn status_error(r: &Http) -> AlphaxivError {
    AlphaxivError::new(
        kind_for_status(r.status),
        format!("alphaXiv answered {}.", r.status),
    )
}

/// The session for this token: initialize once, then reuse its id.
async fn session(token: &str) -> AxResult<Option<String>> {
    if let Some((t, id)) = SESSION.with(|s| s.borrow().clone()) {
        if t == token {
            return Ok(id);
        }
    }
    let id = next_id();
    let r = http(
        MCP_URL,
        "POST",
        mcp_headers(token, None),
        Some(mcp::initialize(id).to_string()),
    )
    .await?;
    if !(200..300).contains(&r.status) {
        return Err(status_error(&r));
    }
    mcp::parse_reply(&r.content_type, &r.body, id).map_err(|e| {
        AlphaxivError::new(
            ErrorKind::Failed,
            format!("alphaXiv would not start a session: {e:?}"),
        )
    })?;
    let _ = http(
        MCP_URL,
        "POST",
        mcp_headers(token, r.session_id.as_deref()),
        Some(mcp::initialized().to_string()),
    )
    .await?;
    SESSION.with(|s| *s.borrow_mut() = Some((token.to_string(), r.session_id.clone())));
    Ok(r.session_id)
}

async fn call_once(token: &str, name: &str, args: &Value) -> AxResult<String> {
    let session_id = session(token).await?;
    let id = next_id();
    let r = http(
        MCP_URL,
        "POST",
        mcp_headers(token, session_id.as_deref()),
        Some(mcp::tool_call(id, name, args).to_string()),
    )
    .await?;
    if r.status == 404 && session_id.is_some() {
        // The server forgot the session: open a new one, once.
        SESSION.with(|s| s.borrow_mut().take());
        return Box::pin(call_once(token, name, args)).await;
    }
    if !(200..300).contains(&r.status) {
        return Err(status_error(&r));
    }
    let result = mcp::parse_reply(&r.content_type, &r.body, id)
        .map_err(|e| AlphaxivError::new(ErrorKind::Failed, format!("{name}: {e:?}")))?;
    let (text, is_error) = mcp::tool_text(&result);
    if is_error {
        let lower = text.to_lowercase();
        let kind = if ["not found", "no such", "unknown paper"]
            .iter()
            .any(|w| lower.contains(w))
        {
            ErrorKind::NotFound
        } else {
            ErrorKind::Failed
        };
        return Err(AlphaxivError::new(
            kind,
            if text.is_empty() {
                format!("{name} failed.")
            } else {
                text
            },
        ));
    }
    Ok(text)
}

/// One alphaXiv tool call; a 401 refreshes the token and retries once.
pub async fn call_tool(name: &str, args: Value) -> AxResult<String> {
    let mut attempt = 0;
    loop {
        let auth = current_auth(attempt > 0).await?;
        match call_once(&auth.access_token, name, &args).await {
            Ok(text) => return Ok(text),
            Err(e) => {
                SESSION.with(|s| s.borrow_mut().take());
                if e.kind == ErrorKind::SignedOut && attempt == 0 {
                    attempt += 1;
                    continue;
                }
                return Err(e);
            }
        }
    }
}

/* ---------- Sync ---------- */

/// Mirror the library, then drain the one-time push. Single-flight; never
/// throws: the outcome lands in alphaxivStatus.
pub async fn sync(force: bool) -> Value {
    let promise = SYNCING.with(|s| {
        s.borrow_mut()
            .get_or_insert_with(|| {
                future_to_promise(async move {
                    let result = sync_inner(force).await;
                    SYNCING.with(|s| s.borrow_mut().take());
                    Ok(to_js(&result).unwrap_or(JsValue::NULL))
                })
            })
            .clone()
    });
    JsFuture::from(promise)
        .await
        .ok()
        .and_then(|v| from_js(v).ok())
        .unwrap_or_else(|| json!({ "ok": false, "error": "failed" }))
}

async fn sync_inner(force: bool) -> Value {
    let auth: Option<AlphaxivAuth> = store::get("alphaxivAuth").await.unwrap_or_default();
    if auth.is_none() {
        return json!({ "ok": false, "error": "signed-out" });
    }
    let status: AlphaxivStatus = store::get("alphaxivStatus").await.unwrap_or_default();
    if !force
        && status
            .last_sync_at
            .is_some_and(|t| now() - t < SYNC_MIN_GAP_MS)
    {
        return json!({ "ok": true });
    }
    let run = async {
        pull_library().await?;
        if push_queued().await? {
            pull_library().await?;
        }
        AxResult::Ok(())
    };
    match run.await {
        Ok(()) => {
            patch_status(|s| {
                s.last_sync_at = Some(now());
                s.error.clear();
            })
            .await;
            json!({ "ok": true })
        }
        Err(e) => {
            let message = if e.kind == ErrorKind::Failed {
                e.message.clone()
            } else {
                error_message(e.kind).to_string()
            };
            patch_status(|s| s.error = message).await;
            json!({ "ok": false, "error": kind_name(e.kind) })
        }
    }
}

fn kind_name(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::SignedOut => "signed-out",
        ErrorKind::RateLimited => "rate-limited",
        ErrorKind::NotFound => "not-found",
        ErrorKind::Offline => "offline",
        ErrorKind::Failed => "failed",
    }
}

/// A failed shelf action as a reply the page can say out loud.
fn failed(e: &AlphaxivError) -> Value {
    json!({ "ok": false, "error": kind_name(e.kind), "message": error_message(e.kind) })
}

/* ---------- The shelf's actions ---------- */

/// Move a book between folders: on the shelf at once, then on alphaXiv; if
/// alphaXiv refuses, the book goes back to the folders it had.
pub async fn move_paper(id: &str, from: &str, to: &str) -> Value {
    let Ok(mut papers) = store::get::<Vec<Paper>>("papers").await else {
        return failed(&offline());
    };
    let Some(before) = shelf::move_paper(&mut papers, id, from, to) else {
        return failed(&AlphaxivError::new(ErrorKind::NotFound, ""));
    };
    let _ = store::set("papers", &papers).await;
    let args = json!({ "paper_ids_or_urls": [id], "from_folder_id": from, "to_folder_id": to });
    match call_tool("move_papers_between_folders", args).await {
        Ok(_) => json!({ "ok": true }),
        Err(e) => {
            // Read again: the reader may have saved progress while alphaXiv answered.
            if let Ok(mut papers) = store::get::<Vec<Paper>>("papers").await {
                if let Some(p) = papers.iter_mut().find(|p| p.id == id) {
                    p.folder_ids = before;
                    let _ = store::set("papers", &papers).await;
                }
            }
            failed(&e)
        }
    }
}

/// Shelve a paper from the cart, then pull the library so it arrives with its title.
pub async fn save_paper(id: &str, folder: &str) -> Value {
    let run = async {
        call_tool(
            "save_papers_to_folder",
            json!({ "paper_ids_or_urls": [id], "folder_id": folder }),
        )
        .await?;
        pull_library().await
    };
    match run.await {
        Ok(()) => json!({ "ok": true }),
        Err(e) => failed(&e),
    }
}

/// Papers in a cart; enough to choose from, few enough to read.
const ARRIVALS_PER_FEED: u32 = 8;

/// Hot and For You, with titles from the arXiv export API (the feeds give ids only).
pub async fn arrivals() -> Value {
    let run = async {
        let limit = json!({ "limit": ARRIVALS_PER_FEED });
        let hot = parse_feed(&call_tool("get_hot_feed", limit.clone()).await?)?;
        let for_you = parse_feed(&call_tool("get_for_you_feed", limit).await?)?;
        let ids: Vec<String> = hot.iter().chain(&for_you).cloned().collect();
        // Titles are a nicety: without arXiv the ids still shelve.
        let xml = if ids.is_empty() {
            String::new()
        } else {
            http(&shelf::arxiv_query_url(&ids), "GET", json!({}), None)
                .await
                .map(|r| r.body)
                .unwrap_or_default()
        };
        AxResult::Ok((
            shelf::arrivals_from_atom(&xml, &hot),
            shelf::arrivals_from_atom(&xml, &for_you),
        ))
    };
    match run.await {
        Ok((hot, for_you)) => json!({ "ok": true, "hot": hot, "forYou": for_you }),
        Err(e) => failed(&e),
    }
}

async fn pull_library() -> AxResult<()> {
    let library =
        parse_library(&call_tool("list_library", json!({ "include_papers": true })).await?)?;
    // Read the shelf after the network call: the reader may have saved progress meanwhile.
    let papers: Vec<Paper> = store::get("papers").await.map_err(|_| offline())?;
    let (folders, papers) = merge_library(&papers, &library, now());
    store::set("folders", &folders)
        .await
        .map_err(|_| offline())?;
    store::set("papers", &papers).await.map_err(|_| offline())
}

/// The v27 queue, saved into alphaXiv folders once; true when anything was written.
async fn push_queued() -> AxResult<bool> {
    let queue: Vec<PushItem> = store::get("alphaxivPush").await.map_err(|_| offline())?;
    if queue.is_empty() {
        return Ok(false);
    }
    let folders: Vec<Folder> = store::get("folders").await.map_err(|_| offline())?;
    let papers: Vec<Paper> = store::get("papers").await.map_err(|_| offline())?;
    let plan = plan_push(&queue, &folders, &papers);
    let mut ids: std::collections::HashMap<String, String> = folders
        .iter()
        .map(|f| (folder_key(&f.name), f.id.clone()))
        .collect();
    for name in &plan.create {
        let id = parse_folder_id(&call_tool("create_folder", json!({ "name": name })).await?)
            .ok_or_else(|| {
                AlphaxivError::new(
                    ErrorKind::Failed,
                    format!("alphaXiv created \"{name}\" but did not say where."),
                )
            })?;
        ids.insert(folder_key(name), id);
    }
    for (folder, paper_ids) in &plan.saves {
        call_tool(
            "save_papers_to_folder",
            json!({ "paper_ids_or_urls": paper_ids, "folder_id": ids.get(&folder_key(folder)) }),
        )
        .await?;
    }
    // Cleared only once every save landed; a failure above leaves it for the next sync.
    store::set("alphaxivPush", &Vec::<PushItem>::new())
        .await
        .map_err(|_| offline())?;
    Ok(!plan.saves.is_empty())
}

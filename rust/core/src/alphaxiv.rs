//! alphaXiv, the pure half: the OAuth request shapes,
//! the MCP tool replies, and how the library folds into the shelf. alphaXiv is
//! the master copy of the library; the shelf keeps only reading state.

use crate::types::{Folder, Paper};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fmt;
use std::sync::LazyLock;

pub const MCP_URL: &str = "https://api.alphaxiv.org/mcp/v1";
pub(crate) const AUTHORIZE_URL: &str = "https://api.alphaxiv.org/auth/oauth2/authorize";
pub const TOKEN_URL: &str = "https://api.alphaxiv.org/auth/oauth2/token";
pub const REGISTER_URL: &str = "https://api.alphaxiv.org/auth/oauth2/register";
pub const USERINFO_URL: &str = "https://api.alphaxiv.org/auth/oauth2/userinfo";
pub const REVOKE_URL: &str = "https://api.alphaxiv.org/auth/oauth2/revoke";
/// offline_access asks for a refresh token; alphaXiv may not grant it.
pub const SCOPE: &str = "openid profile email offline_access";

/// What is stored after sign-in (`alphaxivAuth`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaxivAuth {
    pub client_id: String,
    pub redirect_uri: String,
    pub access_token: String,
    /// '' when alphaXiv issued none: the sign-in then ends with the access token
    pub refresh_token: String,
    /// ms since epoch
    pub expires_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaxivStatus {
    pub email: String,
    pub last_sync_at: Option<i64>,
    /// '' when the last attempt worked
    pub error: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    SignedOut,
    RateLimited,
    NotFound,
    Offline,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AlphaxivError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AlphaxivError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        AlphaxivError {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for AlphaxivError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AlphaxivError {}

/// The sentence Settings shows for each failure.
pub fn error_message(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::SignedOut => "Your alphaXiv sign-in ended. Sign in again to sync your shelf.",
        ErrorKind::RateLimited => "alphaXiv asked us to slow down. The next sync will try again.",
        ErrorKind::NotFound => "alphaXiv could not find that paper or folder.",
        ErrorKind::Offline => "You are offline. The shelf will sync when you are back.",
        ErrorKind::Failed => "alphaXiv did not answer as expected. The next sync will try again.",
    }
}

pub fn kind_for_status(status: u16) -> ErrorKind {
    match status {
        401 | 403 => ErrorKind::SignedOut,
        429 => ErrorKind::RateLimited,
        404 => ErrorKind::NotFound,
        _ => ErrorKind::Failed,
    }
}

/* ---------- OAuth (PKCE, public client) ---------- */

/// base64url without padding (RFC 4648 §5).
pub fn base64url(bytes: &[u8]) -> String {
    crate::base64::encode(bytes, crate::base64::URL_SAFE, false)
}

/// RFC 7636 S256: base64url(sha256(verifier)).
pub fn pkce_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

pub fn authorize_url(client_id: &str, redirect_uri: &str, state: &str, challenge: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        // RFC 8707: the token is for the MCP server.
        .append_pair("resource", MCP_URL)
        .finish();
    format!("{AUTHORIZE_URL}?{query}")
}

/// The code from the redirect, or why there is none. A state mismatch is a forged redirect.
pub fn code_from_redirect(redirect: &str, state: &str) -> Result<String, String> {
    let url = url::Url::parse(redirect)
        .map_err(|_| "alphaXiv sent back an unreadable address.".to_string())?;
    let q: BTreeMap<String, String> = url.query_pairs().into_owned().collect();
    if let Some(error) = q.get("error") {
        return Err(q
            .get("error_description")
            .filter(|d| !d.is_empty())
            .unwrap_or(error)
            .clone());
    }
    if q.get("state").map(String::as_str) != Some(state) {
        return Err("Sign-in reply did not match the request. Try again.".into());
    }
    q.get("code")
        .cloned()
        .ok_or_else(|| "alphaXiv sent no sign-in code.".into())
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<f64>,
}

/// A token endpoint reply as stored auth, a minute short of its expiry. A
/// refresh without `refresh_token` keeps the old one.
pub fn auth_from_token_reply(
    json: &serde_json::Value,
    client_id: &str,
    redirect_uri: &str,
    old_refresh: Option<&str>,
    now: i64,
) -> Result<AlphaxivAuth, AlphaxivError> {
    let t: TokenReply = serde_json::from_value(json.clone())
        .ok()
        .filter(|t: &TokenReply| !t.access_token.is_empty())
        .ok_or_else(|| {
            AlphaxivError::new(ErrorKind::SignedOut, "alphaXiv sent no access token.")
        })?;
    let expires_in = t.expires_in.filter(|e| *e > 0.0).unwrap_or(3600.0);
    Ok(AlphaxivAuth {
        client_id: client_id.into(),
        redirect_uri: redirect_uri.into(),
        access_token: t.access_token,
        refresh_token: t
            .refresh_token
            .or(old_refresh.map(str::to_string))
            .unwrap_or_default(),
        expires_at: now + ((expires_in - 60.0).max(0.0) * 1000.0) as i64,
    })
}

pub fn needs_refresh(auth: &AlphaxivAuth, now: i64) -> bool {
    now >= auth.expires_at
}

/* ---------- MCP tool replies ---------- */

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LibraryPaper {
    pub universal_paper_id: String,
    pub title: String,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub publication_date: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct LibraryFolder {
    pub folder_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub papers: Vec<LibraryPaper>,
    #[serde(default)]
    pub papers_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Library {
    pub folders: Vec<LibraryFolder>,
}

fn parse_json<T: serde::de::DeserializeOwned>(text: &str, tool: &str) -> Result<T, AlphaxivError> {
    let json: serde_json::Value = serde_json::from_str(text).map_err(|_| {
        AlphaxivError::new(
            ErrorKind::Failed,
            format!("{tool}: alphaXiv replied with something other than JSON."),
        )
    })?;
    serde_json::from_value(json).map_err(|_| {
        AlphaxivError::new(
            ErrorKind::Failed,
            format!("{tool}: alphaXiv changed its reply format."),
        )
    })
}

/// list_library (include_papers: true) → the library.
pub fn parse_library(text: &str) -> Result<Library, AlphaxivError> {
    parse_json(text, "list_library")
}

#[derive(Deserialize)]
struct Feed {
    papers: Vec<FeedPaper>,
}
#[derive(Deserialize)]
struct FeedPaper {
    universal_paper_id: String,
}

/// A feed → arXiv ids in app order; link blogs dropped.
pub fn parse_feed(text: &str) -> Result<Vec<String>, AlphaxivError> {
    let feed: Feed = parse_json(text, "feed")?;
    Ok(feed
        .papers
        .into_iter()
        .map(|p| p.universal_paper_id)
        .filter(|id| ARXIV_ID.is_match(id))
        .collect())
}

static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap()
});
/// New-style (2406.09246) and old-style (hep-th/9901001) ids, no version.
static ARXIV_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?/\d{7})$").unwrap());

/// create_folder's reply names the new folder somewhere; the uuid is all we need.
pub fn parse_folder_id(text: &str) -> Option<String> {
    UUID.find(text).map(|m| m.as_str().to_string())
}

/* ---------- Library → shelf ---------- */

fn year_of(date: Option<&str>) -> Option<i32> {
    date.and_then(|d| d.get(..4))
        .and_then(|y| y.parse().ok())
        .filter(|y| *y > 1900)
}

/// Fold alphaXiv's library into the shelf. alphaXiv decides folders; the local
/// record keeps its reading state. A paper alphaXiv drops keeps its progress
/// with no folders; a truncated folder keeps memberships the reply cannot see;
/// uploads and non-arXiv ids are skipped. An unchanged record is returned as is.
pub fn merge_library(local: &[Paper], library: &Library, now: i64) -> (Vec<Folder>, Vec<Paper>) {
    let folders: Vec<Folder> = library
        .folders
        .iter()
        .map(|f| Folder {
            id: f.folder_id.clone(),
            name: f.name.clone(),
            kind: f.kind.clone(),
        })
        .collect();
    let truncated: HashSet<&str> = library
        .folders
        .iter()
        .filter(|f| f.papers_truncated)
        .map(|f| f.folder_id.as_str())
        .collect();

    // Insertion order matters (new papers are appended in library order), so a Vec of ids plus a map.
    let mut order: Vec<&str> = Vec::new();
    let mut remote: BTreeMap<&str, (&str, Option<i32>, BTreeSet<&str>)> = BTreeMap::new();
    for f in &library.folders {
        for p in &f.papers {
            if p.kind.as_deref().is_some_and(|k| k != "public")
                || !ARXIV_ID.is_match(&p.universal_paper_id)
            {
                continue;
            }
            let id = p.universal_paper_id.as_str();
            let entry = remote.entry(id).or_insert_with(|| {
                order.push(id);
                (
                    p.title.as_str(),
                    year_of(p.publication_date.as_deref()),
                    BTreeSet::new(),
                )
            });
            entry.2.insert(f.folder_id.as_str());
        }
    }

    let mut papers = Vec::with_capacity(local.len() + order.len());
    let mut seen = HashSet::new();
    for paper in local {
        seen.insert(paper.id.as_str());
        let r = remote.get(paper.id.as_str());
        let mut folder_ids: Vec<String> = Vec::new();
        for id in r.map(|r| r.2.iter().copied()).into_iter().flatten().chain(
            paper
                .folder_ids
                .iter()
                .map(String::as_str)
                .filter(|id| truncated.contains(id)),
        ) {
            if !folder_ids.iter().any(|f| f == id) {
                folder_ids.push(id.to_string());
            }
        }
        let title = r
            .map(|r| r.0.trim())
            .filter(|t| !t.is_empty())
            .unwrap_or(&paper.title)
            .to_string();
        let year = r.and_then(|r| r.1).or(paper.year);
        let same_folders = folder_ids.len() == paper.folder_ids.len()
            && folder_ids.iter().all(|f| paper.folder_ids.contains(f));
        if title == paper.title && year == paper.year && same_folders {
            papers.push(paper.clone());
        } else {
            papers.push(Paper {
                title,
                year,
                folder_ids,
                updated_at: now,
                ..paper.clone()
            });
        }
    }
    for id in order {
        if seen.contains(id) {
            continue;
        }
        let (title, year, folder_ids) = &remote[id];
        papers.push(Paper {
            id: id.to_string(),
            title: if title.trim().is_empty() {
                id.to_string()
            } else {
                title.trim().to_string()
            },
            authors: String::new(),
            year: *year,
            url: format!("https://arxiv.org/abs/{id}"),
            folder_ids: folder_ids.iter().map(|s| s.to_string()).collect(),
            progress_percent: 0.0,
            left_off: String::new(),
            pdf: None,
            added_at: now,
            updated_at: now,
            last_read_at: None,
        });
    }
    (folders, papers)
}

/* ---------- The one-time push of pre-alphaXiv papers ---------- */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushItem {
    pub id: String,
    pub folder: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PushPlan {
    /// Folder names that do not exist on alphaXiv yet
    pub create: Vec<String>,
    /// (folder name, ids), batches of at most 50 (the tool's cap)
    pub saves: Vec<(String, Vec<String>)>,
}

/// 'Want to read' and 'want  to READ' are the same folder.
pub fn folder_key(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Group the queue by folder, matching existing folders by name, naming the
/// ones to create, skipping papers already there.
pub fn plan_push(queue: &[PushItem], folders: &[Folder], papers: &[Paper]) -> PushPlan {
    let by_key: BTreeMap<String, &Folder> =
        folders.iter().map(|f| (folder_key(&f.name), f)).collect();
    let mut groups: Vec<(String, String, Vec<String>)> = Vec::new(); // (key, display name, ids), in first-seen order
    for item in queue {
        let mut folder = item.folder.trim();
        if folder.is_empty() {
            folder = "Want to read";
        }
        let key = folder_key(folder);
        let existing = by_key.get(&key);
        if let Some(f) = existing {
            if papers
                .iter()
                .any(|p| p.id == item.id && p.folder_ids.contains(&f.id))
            {
                continue;
            }
        }
        // A folder to create is named by its spelling that sorts first (spaces
        // collapsed), not the first one queued, so the name does not hang on order.
        let spelling = folder.split_whitespace().collect::<Vec<_>>().join(" ");
        let i = match groups.iter().position(|g| g.0 == key) {
            Some(i) => {
                if existing.is_none() && spelling < groups[i].1 {
                    groups[i].1 = spelling;
                }
                i
            }
            None => {
                let name = existing.map_or(spelling, |f| f.name.clone());
                groups.push((key.clone(), name, vec![]));
                groups.len() - 1
            }
        };
        if !groups[i].2.contains(&item.id) {
            groups[i].2.push(item.id.clone());
        }
    }
    // Sorted by key: the folders and their names do not depend on queue order
    // (ids within a folder keep it, oldest queued first).
    groups.sort_by(|a, b| a.0.cmp(&b.0));
    let create = groups
        .iter()
        .filter(|g| !by_key.contains_key(&g.0))
        .map(|g| g.1.clone())
        .collect();
    let saves = groups
        .iter()
        .flat_map(|(_, name, ids)| ids.chunks(50).map(move |c| (name.clone(), c.to_vec())))
        .collect();
    PushPlan { create, saves }
}

#[cfg(test)]
mod tests;

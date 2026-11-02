//! The stored shapes (src/shared/types.ts). Field names are camelCase on the
//! wire and absent optionals are left out, so these read and write exactly the
//! JSON the TypeScript build stored: a profile moves across with no migration.

use serde::{Deserialize, Serialize};

/// An alphaXiv folder (bookmark collection); each is a shelf.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// `default-to-read` | `default-reading` | `default-completed` | `default-publications` | custom
    #[serde(rename = "type")]
    pub kind: String,
}

/// Where the in-extension reader left a paper.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfState {
    pub url: String,
    /// 1-based
    pub page: u32,
    pub page_count: u32,
    /// Scroll position within `page`, 0-1
    pub offset: f64,
}

/// A paper on the shelf: alphaXiv's record mirrored, plus local reading state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Paper {
    /// arXiv id ('2406.09246'): alphaXiv's universal_paper_id
    pub id: String,
    pub title: String,
    pub authors: String,
    pub year: Option<i32>,
    /// https://arxiv.org/abs/<id>
    pub url: String,
    pub folder_ids: Vec<String>,
    /// 0-100
    pub progress_percent: f64,
    pub left_off: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf: Option<PdfState>,
    pub added_at: i64,
    pub updated_at: i64,
    pub last_read_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

/// A reading session: distracting sites are blocked while a reader tab is open.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusSession {
    pub started_at: i64,
    pub tab_ids: Vec<i32>,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationColor {
    Yellow,
    Green,
    Blue,
    Pink,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HighlightTag {
    Claim,
    Evidence,
    Doubt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationKind {
    Highlight,
    Sticky,
}

/// One box on a page, as 0-1 fractions of the page size (y-down).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AnnotationRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Where an annotation sits. `kind` is the tag on the wire, as in TypeScript's
/// discriminated union: `#[serde(tag = "kind")]` is that union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AnnotationAnchor {
    Pdf {
        page: u32,
        rects: Vec<AnnotationRect>,
        x: f64,
        y: f64,
    },
    /// From the retired article reader; kept so old records still parse.
    Text {
        #[serde(rename = "blockIndex")]
        block_index: u32,
        quote: String,
        prefix: String,
        suffix: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<HighlightTag>,
    /// Stable document identity: paper_match_key(url), else the normalised url
    pub doc_key: String,
    pub doc_url: String,
    pub paper_id: Option<String>,
    pub kind: AnnotationKind,
    pub anchor: AnnotationAnchor,
    pub text: String,
    pub color: AnnotationColor,
    pub note: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub reader_focus_line: bool,
    pub focus_blocklist: Vec<String>,
    pub claude_key: String,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            reader_focus_line: false,
            focus_blocklist: crate::constants::DEFAULT_FOCUS_BLOCKLIST
                .iter()
                .map(|d| d.to_string())
                .collect(),
            claude_key: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiCacheEntry {
    pub text: String,
    pub target: String,
    pub model: String,
    pub at: i64,
}

/// One local day in the heatmap.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DayActivity {
    /// Distinct papers read that day
    pub papers: Vec<String>,
    /// Reading sessions that ended
    pub focus: u32,
    /// Minutes in reading sessions; absent on days before it shipped
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clocked: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_paper_round_trips_the_typescript_json() {
        let stored = json!({
            "id": "2006.11239", "title": "DDPM", "authors": "Ho", "year": 2020,
            "url": "https://arxiv.org/abs/2006.11239", "folderIds": ["f1"],
            "progressPercent": 23, "leftOff": "3 Diffusion",
            "pdf": { "url": "https://arxiv.org/pdf/2006.11239", "page": 5, "pageCount": 20, "offset": 0.5 },
            "addedAt": 1, "updatedAt": 2, "lastReadAt": null
        });
        let paper: Paper = serde_json::from_value(stored.clone()).unwrap();
        assert_eq!(paper.folder_ids, vec!["f1"]);
        assert_eq!(paper.pdf.as_ref().unwrap().page_count, 20);
        // Written back: the same keys, and no `deletedAt: null` that TS never wrote.
        let back = serde_json::to_value(&paper).unwrap();
        assert_eq!(
            back.as_object().unwrap().keys().collect::<Vec<_>>(),
            stored.as_object().unwrap().keys().collect::<Vec<_>>()
        );
        assert_eq!(back["progressPercent"].as_f64(), Some(23.0));
    }

    #[test]
    fn an_annotation_anchor_is_tagged_on_kind() {
        let a: AnnotationAnchor = serde_json::from_value(json!({ "kind": "pdf", "page": 3, "rects": [{ "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.01 }], "x": 0, "y": 0 })).unwrap();
        assert!(matches!(a, AnnotationAnchor::Pdf { page: 3, .. }));
        let t: AnnotationAnchor = serde_json::from_value(
            json!({ "kind": "text", "blockIndex": 2, "quote": "q", "prefix": "", "suffix": "" }),
        )
        .unwrap();
        assert!(matches!(t, AnnotationAnchor::Text { block_index: 2, .. }));
    }

    #[test]
    fn folder_type_is_renamed_because_type_is_a_keyword() {
        let f: Folder = serde_json::from_value(
            json!({ "id": "a", "name": "Reading", "type": "default-reading" }),
        )
        .unwrap();
        assert_eq!(f.kind, "default-reading");
        assert_eq!(serde_json::to_value(&f).unwrap()["type"], "default-reading");
    }
}

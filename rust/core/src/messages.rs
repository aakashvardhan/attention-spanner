//! Messages from pages to the worker (src/shared/messages.ts). One enum,
//! tagged on `type` with the TS names, so the JSON on the wire is unchanged.

use crate::types::{Annotation, AnnotationAnchor, AnnotationColor, AnnotationKind, HighlightTag};
use serde::{Deserialize, Serialize};

/// An annotation before the worker gives it an id and timestamps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDraft {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<HighlightTag>,
    pub doc_key: String,
    pub doc_url: String,
    pub paper_id: Option<String>,
    pub kind: AnnotationKind,
    pub anchor: AnnotationAnchor,
    pub text: String,
    pub color: AnnotationColor,
    pub note: String,
}

impl AnnotationDraft {
    pub fn into_annotation(self, id: String, now: i64) -> Annotation {
        Annotation {
            id,
            tag: self.tag,
            doc_key: self.doc_key,
            doc_url: self.doc_url,
            paper_id: self.paper_id,
            kind: self.kind,
            anchor: self.anchor,
            text: self.text,
            color: self.color,
            note: self.note,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AnnotationPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<AnnotationColor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<HighlightTag>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Message {
    /// The reader opened a paper: start or join the reading session
    ReaderOpened {
        title: String,
    },
    /// The blocked page's "Back to your paper"
    FocusReader,
    /// The blocked page showed: is a reader tab really still open?
    SessionCheck,
    #[serde(rename = "ALPHAXIV_SIGN_IN")]
    AlphaxivSignIn,
    #[serde(rename = "ALPHAXIV_SIGN_OUT")]
    AlphaxivSignOut,
    #[serde(rename = "ALPHAXIV_SYNC")]
    AlphaxivSync {
        #[serde(default)]
        force: bool,
    },
    /// The shelf moved a book to another folder (alphaXiv's move)
    #[serde(rename = "ALPHAXIV_MOVE", rename_all = "camelCase")]
    AlphaxivMove {
        paper_id: String,
        from: String,
        to: String,
    },
    /// A paper from the New-arrivals cart onto a shelf
    #[serde(rename = "ALPHAXIV_SAVE", rename_all = "camelCase")]
    AlphaxivSave {
        paper_id: String,
        folder_id: String,
    },
    /// Hot and For You, with titles
    #[serde(rename = "ALPHAXIV_ARRIVALS")]
    AlphaxivArrivals,
    #[serde(rename_all = "camelCase")]
    PaperReaderProgress {
        paper_id: String,
        pdf_url: String,
        page: f64,
        page_count: f64,
        offset: f64,
        left_off: String,
        #[serde(default)]
        active_seconds_delta: f64,
    },
    ReaderOpenNative {
        url: String,
    },
    #[serde(rename = "ANNOT_ADD")]
    AnnotAdd {
        draft: AnnotationDraft,
    },
    #[serde(rename = "ANNOT_UPDATE")]
    AnnotUpdate {
        id: String,
        patch: AnnotationPatch,
    },
    #[serde(rename = "ANNOT_MOVE")]
    AnnotMove {
        id: String,
        x: f64,
        y: f64,
    },
    #[serde(rename = "ANNOT_DELETE")]
    AnnotDelete {
        id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_typescript_messages() {
        let cases = [
            (
                json!({ "type": "READER_OPENED", "title": "T" }),
                Message::ReaderOpened { title: "T".into() },
            ),
            (json!({ "type": "FOCUS_READER" }), Message::FocusReader),
            (json!({ "type": "SESSION_CHECK" }), Message::SessionCheck),
            (
                json!({ "type": "ALPHAXIV_SIGN_IN" }),
                Message::AlphaxivSignIn,
            ),
            (
                json!({ "type": "ALPHAXIV_SYNC" }),
                Message::AlphaxivSync { force: false },
            ),
            (
                json!({ "type": "ALPHAXIV_MOVE", "paperId": "p", "from": "a", "to": "b" }),
                Message::AlphaxivMove {
                    paper_id: "p".into(),
                    from: "a".into(),
                    to: "b".into(),
                },
            ),
            (
                json!({ "type": "ALPHAXIV_SAVE", "paperId": "p", "folderId": "b" }),
                Message::AlphaxivSave {
                    paper_id: "p".into(),
                    folder_id: "b".into(),
                },
            ),
            (
                json!({ "type": "ALPHAXIV_ARRIVALS" }),
                Message::AlphaxivArrivals,
            ),
            (
                json!({ "type": "ALPHAXIV_SYNC", "force": true }),
                Message::AlphaxivSync { force: true },
            ),
            (
                json!({ "type": "ANNOT_MOVE", "id": "a", "x": 0.1, "y": 0.2 }),
                Message::AnnotMove {
                    id: "a".into(),
                    x: 0.1,
                    y: 0.2,
                },
            ),
            (
                json!({ "type": "ANNOT_UPDATE", "id": "a", "patch": { "color": "green" } }),
                Message::AnnotUpdate {
                    id: "a".into(),
                    patch: AnnotationPatch {
                        color: Some(AnnotationColor::Green),
                        ..Default::default()
                    },
                },
            ),
        ];
        for (wire, want) in cases {
            assert_eq!(
                serde_json::from_value::<Message>(wire.clone()).unwrap(),
                want,
                "{wire}"
            );
        }
        let progress: Message = serde_json::from_value(json!({
            "type": "PAPER_READER_PROGRESS", "paperId": "p", "pdfUrl": "u", "page": 2, "pageCount": 10, "offset": 0.5, "leftOff": "", "activeSecondsDelta": 5
        }))
        .unwrap();
        assert!(
            matches!(progress, Message::PaperReaderProgress { page_count, .. } if page_count == 10.0)
        );
    }

    #[test]
    fn writes_the_type_tag_the_pages_send() {
        assert_eq!(
            serde_json::to_value(Message::ReaderOpenNative { url: "u".into() }).unwrap(),
            json!({ "type": "READER_OPEN_NATIVE", "url": "u" })
        );
        assert_eq!(
            serde_json::to_value(Message::AnnotDelete { id: "a".into() }).unwrap(),
            json!({ "type": "ANNOT_DELETE", "id": "a" })
        );
    }

    #[test]
    fn an_unknown_type_is_an_error_not_a_guess() {
        assert!(serde_json::from_value::<Message>(json!({ "type": "REFRESH_FEEDS" })).is_err());
    }
}

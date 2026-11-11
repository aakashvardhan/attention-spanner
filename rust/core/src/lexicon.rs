//! The lexicon: terms kept from papers, and the links Haiku proposes between
//! them. A term's id is its key (lowercased, spaces folded), so the same term
//! kept from two papers is one node with two sources.

use crate::ai::{AiRequest, Task};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A kept label longer than this is cut (a click never takes more than a word,
/// but stored data is not trusted).
const TERM_MAX_CHARS: usize = 80;
/// Each term's definition, as Haiku reads it in a link request.
const LINK_DEF_CHARS: usize = 160;
/// New terms per "Find links" press.
pub(crate) const LINK_BATCH: usize = 60;
const RELATION_MAX_CHARS: usize = 40;
const WHY_MAX_CHARS: usize = 240;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Source {
    pub doc_key: String,
    pub paper_title: String,
    pub definition: String,
    pub guess: String,
    pub context: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Term {
    /// The key: lowercased, whitespace folded
    pub id: String,
    pub label: String,
    pub sources: Vec<Source>,
    /// When "Find links" last read it; `None` = new
    pub linked_at: Option<i64>,
}

/// Undirected for de-duplication; `relation` reads a → b.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Edge {
    pub a: String,
    pub b: String,
    pub relation: String,
    pub why: String,
    pub at: i64,
}

impl Edge {
    pub fn joins(&self, x: &str, y: &str) -> bool {
        (self.a == x && self.b == y) || (self.a == y && self.b == x)
    }
    pub fn touches(&self, id: &str) -> bool {
        self.a == id || self.b == id
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Lexicon {
    pub terms: Vec<Term>,
    pub edges: Vec<Edge>,
}

/// Resolve a saved source through the library; document keys are not URLs.
pub fn source_reader_path(source: &Source, papers: &[crate::types::Paper]) -> Option<String> {
    use crate::annotations::annotation_doc_key;
    use crate::pdf::{paper_pdf_source, reader_page_path};

    let paper = papers.iter().find(|p| {
        annotation_doc_key(&p.url) == source.doc_key
            || p.pdf
                .as_ref()
                .is_some_and(|pdf| annotation_doc_key(&pdf.url) == source.doc_key)
    })?;
    paper_pdf_source(&paper.url, paper.pdf.as_ref().map(|pdf| pdf.url.as_str()))
        .map(|url| reader_page_path(&url))
}

fn cut(s: &str, max: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= max {
        s
    } else {
        let mut out: String = s.chars().take(max - 1).collect();
        out.push('…');
        out
    }
}

/// Lowercased, whitespace folded and trimmed, capped. Empty for a blank term.
pub fn term_key(label: &str) -> String {
    cut(label, TERM_MAX_CHARS).to_lowercase()
}

/// Keep a term. The same term merges into one node; the same paper again
/// replaces its source. `false` for a blank label.
pub fn add_term(lex: &mut Lexicon, label: &str, source: Source) -> bool {
    let id = term_key(label);
    if id.is_empty() {
        return false;
    }
    match lex.terms.iter_mut().find(|t| t.id == id) {
        Some(t) => match t.sources.iter_mut().find(|s| s.doc_key == source.doc_key) {
            Some(s) => *s = source,
            None => {
                t.sources.push(source);
                // A new paper's meaning may link differently.
                t.linked_at = None;
            }
        },
        None => lex.terms.push(Term {
            id,
            label: cut(label, TERM_MAX_CHARS),
            sources: vec![source],
            linked_at: None,
        }),
    }
    true
}

/// A definition as click-to-define writes it, `**Term**: definition`, split
/// into the term Haiku named (it widens a clicked word to its whole term) and
/// the definition. Any other shape is all definition.
pub fn split_definition(text: &str) -> (Option<String>, String) {
    let t = text.trim();
    let parsed = t.strip_prefix("**").and_then(|rest| {
        let (term, def) = rest.split_once("**")?;
        let def = def.trim_start().strip_prefix(':').unwrap_or(def);
        let term = term.trim().trim_end_matches(':').trim();
        (!term.is_empty()).then(|| (term.to_string(), def.trim().to_string()))
    });
    match parsed {
        Some((term, def)) => (Some(term), def),
        None => (None, t.to_string()),
    }
}

/// Drop a term and every edge on it.
pub fn remove_term(lex: &mut Lexicon, id: &str) {
    lex.terms.retain(|t| t.id != id);
    lex.edges.retain(|e| !e.touches(id));
}

pub fn remove_edge(lex: &mut Lexicon, a: &str, b: &str) {
    lex.edges.retain(|e| !e.joins(a, b));
}

/// Terms "Find links" has not read yet, oldest first, at most one batch.
pub fn unlinked(lex: &Lexicon) -> Vec<&Term> {
    lex.terms
        .iter()
        .filter(|t| t.linked_at.is_none())
        .take(LINK_BATCH)
        .collect()
}

pub(crate) fn link_system() -> String {
    "You map how research terms relate, for a PhD student building a literature map. You get \
a list of terms, each as id | term | definition, and the ids of the NEW terms. Propose links \
where one term genuinely bears on another: one is a kind of, part of, measure of, input to, \
alternative to, or contrast with the other. Every link must touch at least one NEW term. Skip \
weak or merely topical links; fewer, sharper links are better. Reply with only a JSON array, \
no prose: [{\"a\": id, \"b\": id, \"relation\": \"at most four words, read a then b\", \
\"why\": \"one plain sentence\"}]. Reply [] if nothing links."
        .to_string()
}

/// The "Find links" request: every term as context, the unlinked ones as new.
/// `None` with fewer than two terms or nothing new. Never cached: the answer
/// depends on the whole lexicon.
pub fn link_request(lex: &Lexicon) -> Option<AiRequest> {
    let new = unlinked(lex);
    if lex.terms.len() < 2 || new.is_empty() {
        return None;
    }
    let list = lex
        .terms
        .iter()
        .map(|t| {
            let def = t
                .sources
                .first()
                .map(|s| s.definition.as_str())
                .unwrap_or("");
            format!("{} | {} | {}", t.id, t.label, cut(def, LINK_DEF_CHARS))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let ids = new
        .iter()
        .map(|t| t.id.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    Some(AiRequest {
        task: Task::Link,
        system: link_system(),
        passages: vec![list],
        prompt: format!("NEW term ids:\n{ids}\n\nThe JSON array of links:"),
        cache_key: None,
    })
}

/// Haiku's reply as edges against the lexicon as it is now: unknown ids,
/// self-links and repeats are dropped. `Err` when there is no JSON array.
pub fn parse_links(text: &str, lex: &Lexicon, now: i64) -> Result<Vec<Edge>, String> {
    let bad = || "Claude's links could not be read. Try again.".to_string();
    let (start, end) = (
        text.find('[').ok_or_else(bad)?,
        text.rfind(']').ok_or_else(bad)?,
    );
    if end < start {
        return Err(bad());
    }
    let items: Vec<Value> = serde_json::from_str(&text[start..=end]).map_err(|_| bad())?;
    let known = |id: &str| lex.terms.iter().any(|t| t.id == id);
    let mut out: Vec<Edge> = vec![];
    for v in items {
        let field = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let (a, b) = (term_key(&field("a")), term_key(&field("b")));
        let relation = cut(&field("relation"), RELATION_MAX_CHARS);
        if a == b || !known(&a) || !known(&b) || relation.is_empty() {
            continue;
        }
        if out.iter().any(|e| e.joins(&a, &b)) {
            continue;
        }
        out.push(Edge {
            a,
            b,
            relation,
            why: cut(&field("why"), WHY_MAX_CHARS),
            at: now,
        });
    }
    Ok(out)
}

/// Add new edges; a pair already linked keeps its edge, and an edge between
/// two old terms is dropped (the prompt asks for links touching a NEW term,
/// one of `sent`). Marks `sent` linked. Returns how many edges were added.
pub fn merge_links(lex: &mut Lexicon, edges: Vec<Edge>, sent: &[String], now: i64) -> usize {
    let mut added = 0;
    for e in edges
        .into_iter()
        .filter(|e| sent.contains(&e.a) || sent.contains(&e.b))
    {
        let live = lex
            .terms
            .iter()
            .filter(|t| t.id == e.a || t.id == e.b)
            .count()
            == 2;
        if live && !lex.edges.iter().any(|x| x.joins(&e.a, &e.b)) {
            lex.edges.push(e);
            added += 1;
        }
    }
    for t in lex.terms.iter_mut().filter(|t| sent.contains(&t.id)) {
        t.linked_at = Some(now);
    }
    added
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(doc: &str, def: &str) -> Source {
        Source {
            doc_key: doc.into(),
            paper_title: format!("Paper {doc}"),
            definition: def.into(),
            ..Source::default()
        }
    }

    fn lex(labels: &[&str]) -> Lexicon {
        let mut l = Lexicon::default();
        for t in labels {
            add_term(&mut l, t, src("p1", &format!("{t} means something")));
        }
        l
    }

    #[test]
    fn splits_the_term_haiku_named() {
        assert_eq!(
            split_definition(
                "**Temporal-difference learning**: learning from the gap between guesses."
            ),
            (
                Some("Temporal-difference learning".into()),
                "learning from the gap between guesses.".into()
            )
        );
        assert_eq!(
            split_definition("**TD:** a method."),
            (Some("TD".into()), "a method.".into())
        );
        assert_eq!(
            split_definition("  plain text "),
            (None, "plain text".into())
        );
        assert_eq!(
            split_definition("**unclosed: x"),
            (None, "**unclosed: x".into())
        );
        assert_eq!(split_definition("****: x"), (None, "****: x".into()));
    }

    #[test]
    fn keys_fold_case_and_space() {
        assert_eq!(
            term_key("  Temporal-Difference \n Learning "),
            "temporal-difference learning"
        );
        assert_eq!(term_key("Ångström"), "ångström");
        assert_eq!(term_key("$\\epsilon$-greedy"), "$\\epsilon$-greedy");
        assert_eq!(term_key("   "), "");
        assert_eq!(term_key(&"x".repeat(500)).chars().count(), TERM_MAX_CHARS);
        // Plurals stay apart: guessing stems would merge "attention" and "attentions" wrongly elsewhere.
        assert_ne!(term_key("Transformers"), term_key("transformer"));
    }

    #[test]
    fn saved_sources_open_the_library_pdf_and_hide_missing_papers() {
        let paper = crate::types::Paper {
            url: "https://arxiv.org/abs/2006.11239v2".into(),
            pdf: Some(crate::types::PdfState {
                url: "https://example.com/paper.pdf?a=1&b=2".into(),
                page: 1,
                page_count: 10,
                offset: 0.0,
            }),
            ..Default::default()
        };
        let expected = crate::pdf::reader_page_path(&paper.pdf.as_ref().unwrap().url);
        for key in ["arxiv:2006.11239", "url:example.com/paper.pdf"] {
            assert_eq!(
                source_reader_path(&src(key, "meaning"), std::slice::from_ref(&paper)),
                Some(expected.clone())
            );
        }
        let source = src("arxiv:2006.11239", "meaning");
        assert_eq!(source_reader_path(&source, &[]), None);
    }

    #[test]
    fn one_node_per_term_one_source_per_paper() {
        let mut l = Lexicon::default();
        assert!(add_term(&mut l, "TD", src("p1", "old")));
        assert!(add_term(&mut l, "td", src("p2", "other paper")));
        assert!(add_term(&mut l, "TD ", src("p1", "new")));
        assert!(!add_term(&mut l, " ", src("p1", "blank")));
        assert_eq!(l.terms.len(), 1);
        let t = &l.terms[0];
        assert_eq!((t.id.as_str(), t.label.as_str()), ("td", "TD"));
        assert_eq!(t.sources.len(), 2);
        assert_eq!(t.sources[0].definition, "new");
    }

    #[test]
    fn a_new_paper_relinks_a_term() {
        let mut l = lex(&["a", "b"]);
        l.terms[0].linked_at = Some(1);
        add_term(&mut l, "a", src("p1", "same paper"));
        assert_eq!(l.terms[0].linked_at, Some(1));
        add_term(&mut l, "a", src("p2", "another"));
        assert_eq!(l.terms[0].linked_at, None);
    }

    #[test]
    fn removing_a_term_drops_its_edges() {
        let mut l = lex(&["a", "b", "c"]);
        let e = parse_links(
            r#"[{"a":"a","b":"b","relation":"r"},{"a":"b","b":"c","relation":"r"}]"#,
            &l,
            0,
        )
        .unwrap();
        merge_links(&mut l, e, &[], 0);
        remove_term(&mut l, "b");
        assert!(l.edges.is_empty());
        assert_eq!(l.terms.len(), 2);
        let e = parse_links(r#"[{"a":"a","b":"c","relation":"r"}]"#, &l, 0).unwrap();
        merge_links(&mut l, e, &[], 0);
        remove_edge(&mut l, "c", "a");
        assert!(l.edges.is_empty());
    }

    #[test]
    fn link_request_needs_two_terms_and_something_new() {
        assert!(link_request(&Lexicon::default()).is_none());
        assert!(link_request(&lex(&["a"])).is_none());
        let mut l = lex(&["a", "b", "c"]);
        l.terms[0].linked_at = Some(1);
        let r = link_request(&l).unwrap();
        assert_eq!(r.task, Task::Link);
        assert!(r.cache_key.is_none());
        assert!(r.passages[0].contains("a | a | a means something"));
        assert!(r.prompt.contains("b\nc"));
        assert!(!r.prompt.contains("\na\n"));
        for t in &mut l.terms {
            t.linked_at = Some(1);
        }
        assert!(link_request(&l).is_none());
    }

    #[test]
    fn a_batch_is_capped() {
        let labels: Vec<String> = (0..LINK_BATCH + 5).map(|i| format!("t{i}")).collect();
        let l = lex(&labels.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(unlinked(&l).len(), LINK_BATCH);
    }

    #[test]
    fn parses_fenced_or_wrapped_json() {
        let l = lex(&["a", "b"]);
        let fenced = "```json\n[{\"a\":\"A\",\"b\":\"b\",\"relation\":\"is a kind of\",\"why\":\"Because.\"}]\n```";
        let e = parse_links(fenced, &l, 7).unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(
            (e[0].a.as_str(), e[0].relation.as_str(), e[0].at),
            ("a", "is a kind of", 7)
        );
        let prose = "Here you go: [{\"a\":\"a\",\"b\":\"b\",\"relation\":\"r\"}] Hope it helps.";
        assert_eq!(parse_links(prose, &l, 0).unwrap().len(), 1);
        assert_eq!(parse_links("[]", &l, 0).unwrap(), vec![]);
        assert!(parse_links("no links here", &l, 0).is_err());
        assert!(parse_links("] backwards [", &l, 0).is_err());
        assert!(parse_links("[{oops}]", &l, 0).is_err());
    }

    #[test]
    fn drops_unknown_self_repeated_and_unlabelled_links() {
        let l = lex(&["a", "b"]);
        let reply = r#"[
            {"a":"a","b":"ghost","relation":"r"},
            {"a":"a","b":"a","relation":"r"},
            {"a":"a","b":"b","relation":"r"},
            {"a":"b","b":"a","relation":"again"},
            {"a":"a","b":"b"},
            "not an object"
        ]"#;
        let e = parse_links(reply, &l, 0).unwrap();
        assert_eq!(e.len(), 1);
        let long = format!(
            r#"[{{"a":"a","b":"b","relation":"{}","why":"{}"}}]"#,
            "r".repeat(99),
            "w".repeat(999)
        );
        let e = parse_links(&long, &l, 0).unwrap();
        assert_eq!(e[0].relation.chars().count(), RELATION_MAX_CHARS);
        assert_eq!(e[0].why.chars().count(), WHY_MAX_CHARS);
    }

    #[test]
    fn merging_keeps_existing_links_and_marks_the_batch() {
        let mut l = lex(&["a", "b", "c"]);
        let first = parse_links(r#"[{"a":"a","b":"b","relation":"mine"}]"#, &l, 0).unwrap();
        assert_eq!(merge_links(&mut l, first, &["b".to_string()], 0), 1);
        let again = parse_links(
            r#"[{"a":"b","b":"a","relation":"theirs"},{"a":"c","b":"a","relation":"new"}]"#,
            &l,
            0,
        )
        .unwrap();
        let sent = vec!["c".to_string()];
        assert_eq!(merge_links(&mut l, again, &sent, 5), 1);
        assert_eq!(l.edges[0].relation, "mine");
        assert_eq!(l.terms[2].linked_at, Some(5));
        assert_eq!(l.terms[0].linked_at, None);
    }

    #[test]
    fn an_edge_between_two_old_terms_is_dropped() {
        let mut l = lex(&["a", "b", "c"]);
        let e = parse_links(
            r#"[{"a":"a","b":"b","relation":"old"},{"a":"b","b":"c","relation":"new"}]"#,
            &l,
            0,
        )
        .unwrap();
        assert_eq!(merge_links(&mut l, e, &["c".to_string()], 0), 1);
        assert_eq!(l.edges.len(), 1);
        assert_eq!(l.edges[0].relation, "new");
    }

    #[test]
    fn a_term_deleted_mid_call_gets_no_edge() {
        let mut l = lex(&["a", "b"]);
        let e = parse_links(r#"[{"a":"a","b":"b","relation":"r"}]"#, &l, 0).unwrap();
        remove_term(&mut l, "b");
        assert_eq!(merge_links(&mut l, e, &["b".to_string()], 0), 0);
        assert!(l.edges.is_empty());
    }

    #[test]
    fn serde_is_camel_case_and_tolerates_old_data() {
        let l = lex(&["a"]);
        let json = serde_json::to_value(&l).unwrap();
        assert!(json["terms"][0].get("linkedAt").is_some());
        assert!(json["terms"][0]["sources"][0].get("docKey").is_some());
        assert_eq!(serde_json::from_value::<Lexicon>(json).unwrap(), l);
        let partial: Lexicon =
            serde_json::from_str(r#"{"terms":[{"id":"x","label":"X"}]}"#).unwrap();
        assert!(partial.edges.is_empty());
        assert_eq!(partial.terms[0].linked_at, None);
        assert!(serde_json::from_str::<Lexicon>("{}")
            .unwrap()
            .terms
            .is_empty());
    }
}

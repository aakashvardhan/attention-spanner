//! The bookcase: a book's spine (a short code, a thickness from its page
//! count, wear from how far it is read), arrow keys across shelves, a move
//! between alphaXiv folders, and the titles for the New-arrivals cart.

use crate::types::Paper;
use regex::Regex;
use std::sync::LazyLock;

/// Spine letters before the code is cut.
const SPINE_MAX_CHARS: usize = 10;
/// A paper the reader has not opened yet has no page count; it gets a typical one.
const DEFAULT_PAGES: u32 = 12;
const SPINE_MIN_PX: u32 = 20;
const SPINE_MAX_PX: u32 = 48;

const SKIP: [&str; 9] = [
    "a", "an", "the", "on", "of", "towards", "toward", "for", "to",
];

/// "Mamba: Linear-Time Sequence Modeling…" (2023) → "Mamba '23". A short name
/// before a colon is the paper's own name; otherwise its first real word.
pub fn spine_code(title: &str, year: Option<i32>) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .filter(|c| !matches!(c, '$' | '_' | '{' | '}' | '\\' | '"' | '\''))
            .collect::<String>()
            .trim()
            .to_string()
    };
    let name = match title.split_once(':') {
        Some((head, _)) if head.split_whitespace().count() <= 3 && !clean(head).is_empty() => {
            clean(head)
        }
        _ => title
            .split_whitespace()
            .map(clean)
            .find(|w| !w.is_empty() && !SKIP.contains(&w.to_lowercase().as_str()))
            .unwrap_or_default(),
    };
    let mut code: String = name.chars().take(SPINE_MAX_CHARS).collect();
    if name.chars().count() > SPINE_MAX_CHARS {
        code.pop();
        code.push('…');
    }
    if code.is_empty() {
        code = "?".into();
    }
    match year {
        Some(y) => format!("{code} '{:02}", y.rem_euclid(100)),
        None => code,
    }
}

/// Spine width in px: thicker for longer papers, within a readable range.
pub fn thickness(paper: &Paper) -> u32 {
    let pages = paper
        .pdf
        .as_ref()
        .map_or(DEFAULT_PAGES, |p| p.page_count.max(1));
    (SPINE_MIN_PX + pages / 2).clamp(SPINE_MIN_PX, SPINE_MAX_PX)
}

/// 0 untouched, 1 started, 2 well into it, 3 finished.
pub fn wear(progress_percent: f64) -> u8 {
    match progress_percent {
        p if p >= 100.0 => 3,
        p if p >= 50.0 => 2,
        p if p >= 1.0 => 1,
        _ => 0,
    }
}

/// The arrow keys over the bookcase: `lens` are the books per shelf, `at` is
/// (shelf, book). Up and down skip empty shelves and keep the column where
/// they can. `None` for a key that does not move.
pub fn step(lens: &[usize], at: (usize, usize), key: &str) -> Option<(usize, usize)> {
    let (s, b) = at;
    let len = *lens.get(s)?;
    let shelf_from = |mut range: Box<dyn Iterator<Item = usize>>| {
        range
            .find(|&i| lens[i] > 0)
            .map(|i| (i, b.min(lens[i] - 1)))
    };
    match key {
        "ArrowRight" if b + 1 < len => Some((s, b + 1)),
        "ArrowLeft" if b > 0 => Some((s, b - 1)),
        "Home" => Some((s, 0)),
        "End" if len > 0 => Some((s, len - 1)),
        "ArrowDown" => shelf_from(Box::new(s + 1..lens.len())),
        "ArrowUp" => shelf_from(Box::new((0..s).rev())),
        _ => None,
    }
}

/// Move a paper from one folder to another on the local shelf; the folders it
/// had before, for putting it back if alphaXiv refuses. `None` when the paper
/// is not on the shelf.
pub fn move_paper(papers: &mut [Paper], id: &str, from: &str, to: &str) -> Option<Vec<String>> {
    let p = papers.iter_mut().find(|p| p.id == id)?;
    let before = p.folder_ids.clone();
    p.folder_ids.retain(|f| f != from);
    if !p.folder_ids.iter().any(|f| f == to) {
        p.folder_ids.push(to.to_string());
    }
    Some(before)
}

/// A book in the New-arrivals cart.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Arrival {
    pub id: String,
    pub title: String,
}

static ENTRY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<entry>(.*?)</entry>").unwrap());
static ENTRY_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<id>https?://arxiv\.org/abs/([^<]+?)(?:v\d+)?</id>").unwrap());
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<title>(.*?)</title>").unwrap());

/// The arXiv export API's Atom reply → titles, in the order `ids` asked for.
/// An id arXiv does not know keeps its id as its title.
pub fn arrivals_from_atom(xml: &str, ids: &[String]) -> Vec<Arrival> {
    let found: Vec<(String, String)> = ENTRY
        .captures_iter(xml)
        .filter_map(|e| {
            let body = e.get(1)?.as_str();
            let id = ENTRY_ID.captures(body)?.get(1)?.as_str().to_string();
            let raw = TITLE.captures(body)?.get(1)?.as_str();
            let title = raw
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&amp;", "&");
            Some((id, title))
        })
        .collect();
    ids.iter()
        .map(|id| Arrival {
            id: id.clone(),
            title: found
                .iter()
                .find(|(f, _)| f == id)
                .map_or_else(|| id.clone(), |(_, t)| t.clone()),
        })
        .collect()
}

pub fn arxiv_query_url(ids: &[String]) -> String {
    format!(
        "https://export.arxiv.org/api/query?id_list={}&max_results={}",
        ids.join(","),
        ids.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::PdfState;

    #[test]
    fn spine_codes_name_the_paper_and_its_year() {
        assert_eq!(
            spine_code("Mamba: Linear-Time Sequence Modeling", Some(2023)),
            "Mamba '23"
        );
        assert_eq!(
            spine_code("$π_0$: A Vision-Language-Action Flow Model", Some(2024)),
            "π0 '24"
        );
        assert_eq!(
            spine_code("Attention Is All You Need", Some(2017)),
            "Attention '17"
        );
        assert_eq!(spine_code("Towards a Theory of Everything", None), "Theory");
        assert_eq!(
            spine_code("Superconductivityandmore", Some(2005)),
            "Supercond… '05"
        );
        assert_eq!(
            spine_code("注意力机制的研究", Some(2020)),
            "注意力机制的研究 '20"
        );
        assert_eq!(spine_code("", None), "?");
        // A long head before the colon is a sentence, not a name.
        assert_eq!(
            spine_code("On the Hardness of Things: A Survey", None),
            "Hardness"
        );
    }

    #[test]
    fn thickness_follows_pages_and_wear_follows_progress() {
        let mut p = Paper::default();
        assert_eq!(thickness(&p), SPINE_MIN_PX + DEFAULT_PAGES / 2);
        p.pdf = Some(PdfState {
            url: String::new(),
            page: 1,
            page_count: 0,
            offset: 0.0,
        });
        assert_eq!(thickness(&p), SPINE_MIN_PX);
        p.pdf.as_mut().unwrap().page_count = 400;
        assert_eq!(thickness(&p), SPINE_MAX_PX);
        assert_eq!(
            [0.0, 0.5, 30.0, 50.0, 99.9, 100.0].map(wear),
            [0, 0, 1, 2, 2, 3]
        );
    }

    #[test]
    fn arrows_walk_books_and_skip_empty_shelves() {
        let lens = [3, 0, 2];
        assert_eq!(step(&lens, (0, 1), "ArrowRight"), Some((0, 2)));
        assert_eq!(step(&lens, (0, 2), "ArrowRight"), None);
        assert_eq!(
            step(&lens, (0, 2), "ArrowDown"),
            Some((2, 1)),
            "column clamped, empty shelf skipped"
        );
        assert_eq!(step(&lens, (2, 0), "ArrowUp"), Some((0, 0)));
        assert_eq!(step(&lens, (0, 0), "ArrowUp"), None);
        assert_eq!(step(&lens, (0, 0), "End"), Some((0, 2)));
        assert_eq!(step(&lens, (0, 0), "x"), None);
    }

    #[test]
    fn a_move_swaps_the_folder_and_returns_what_to_restore() {
        let mut papers = vec![Paper {
            id: "a".into(),
            folder_ids: vec!["x".into(), "y".into()],
            ..Default::default()
        }];
        assert_eq!(
            move_paper(&mut papers, "a", "x", "y"),
            Some(vec!["x".into(), "y".into()])
        );
        assert_eq!(
            papers[0].folder_ids,
            ["y"],
            "already in the target: no duplicate"
        );
        move_paper(&mut papers, "a", "y", "z");
        assert_eq!(papers[0].folder_ids, ["z"]);
        assert_eq!(move_paper(&mut papers, "nope", "x", "y"), None);
    }

    #[test]
    fn arrivals_read_atom_titles_in_feed_order() {
        let xml = r#"<feed><entry><id>http://arxiv.org/abs/1706.03762v7</id>
<title>Attention Is All
  You Need &amp; More</title></entry>
<entry><id>http://arxiv.org/abs/2006.11239v2</id><title>Denoising Diffusion</title></entry></feed>"#;
        let ids = ["2006.11239", "1706.03762", "2601.00001"].map(String::from);
        let got = arrivals_from_atom(xml, &ids);
        assert_eq!(
            got.iter().map(|a| a.title.as_str()).collect::<Vec<_>>(),
            [
                "Denoising Diffusion",
                "Attention Is All You Need & More",
                "2601.00001"
            ]
        );
        assert!(arxiv_query_url(&ids)
            .ends_with("id_list=2006.11239,1706.03762,2601.00001&max_results=3"));
    }
}

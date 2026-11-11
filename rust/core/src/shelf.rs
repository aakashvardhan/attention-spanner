//! The bookshelf: arrow keys across shelves, a move between alphaXiv
//! folders, and the titles for the New-arrivals cart.

use crate::types::Paper;
use regex::Regex;
use std::sync::LazyLock;

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
            Some((id, unescape(raw)))
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

static ENTITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|quot|apos|amp));").unwrap()
});

/// Collapse whitespace and undo the XML entities: the five named ones and any
/// numeric one (&#39;, &#x27;). One pass, so &amp;#39; stays &#39;.
pub fn unescape(raw: &str) -> String {
    let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    ENTITY
        .replace_all(&text, |c: &regex::Captures| {
            let code = c
                .get(1)
                .map(|h| u32::from_str_radix(h.as_str(), 16))
                .or_else(|| c.get(2).map(|d| d.as_str().parse()));
            match (code, c.get(3).map(|n| n.as_str())) {
                (Some(Ok(n)), _) => {
                    char::from_u32(n).map_or_else(|| c[0].to_string(), String::from)
                }
                (_, Some("lt")) => "<".into(),
                (_, Some("gt")) => ">".into(),
                (_, Some("quot")) => "\"".into(),
                (_, Some("apos")) => "'".into(),
                (_, Some("amp")) => "&".into(),
                _ => c[0].to_string(),
            }
        })
        .into_owned()
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

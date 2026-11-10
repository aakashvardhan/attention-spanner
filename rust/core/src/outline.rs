//! A PDF's outline, flattened, and the heading a page sits under. pdf.js resolves destinations asynchronously, so
//! the caller hands in a synchronous lookup and everything here stays pure.

/// pdf.js `getOutline()` items, only the fields used. `D` is whatever the
/// destination is (a name or an array); generic, so tests can use `&str`.
#[derive(Debug, Clone)]
pub struct RawOutlineItem<D> {
    pub title: String,
    pub dest: D,
    pub items: Vec<RawOutlineItem<D>>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FlatOutlineItem {
    pub title: String,
    /// Nesting depth, 0 for top-level sections
    pub level: u32,
    /// 1-based page the heading points at
    pub page: u32,
}

/// Depth-first flatten; an item whose dest does not resolve is dropped but its
/// children are still visited, one level deeper.
pub fn flatten_outline<D>(
    items: &[RawOutlineItem<D>],
    page_for_dest: impl Fn(&D) -> Option<u32>,
) -> Vec<FlatOutlineItem> {
    // A nested fn can't capture `page_for_dest`, so the recursion takes it by reference.
    fn walk<D>(
        nodes: &[RawOutlineItem<D>],
        level: u32,
        lookup: &dyn Fn(&D) -> Option<u32>,
        out: &mut Vec<FlatOutlineItem>,
    ) {
        for node in nodes {
            if let Some(page) = lookup(&node.dest) {
                out.push(FlatOutlineItem {
                    title: node.title.trim().to_string(),
                    level,
                    page,
                });
            }
            walk(&node.items, level + 1, lookup, out);
        }
    }
    let mut out = Vec::new();
    walk(items, 0, &page_for_dest, &mut out);
    out
}

/// Index of the heading the reader is in on `page`: the nearest at or before
/// it, the last of several on one page; `None` before the first heading.
pub fn section_index_at(flat: &[FlatOutlineItem], page: u32) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, item) in flat.iter().enumerate() {
        if item.page <= page && best.is_none_or(|b| item.page >= flat[b].page) {
            best = Some(i);
        }
    }
    best
}

pub fn heading_for_page(flat: &[FlatOutlineItem], page: u32) -> Option<&str> {
    section_index_at(flat, page).map(|i| flat[i].title.as_str())
}

/// The outermost sections: the shallowest level present.
pub fn top_level(flat: &[FlatOutlineItem]) -> Vec<FlatOutlineItem> {
    let Some(top) = flat.iter().map(|i| i.level).min() else {
        return vec![];
    };
    flat.iter().filter(|i| i.level == top).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(
        title: &str,
        dest: &'static str,
        items: Vec<RawOutlineItem<&'static str>>,
    ) -> RawOutlineItem<&'static str> {
        RawOutlineItem {
            title: title.into(),
            dest,
            items,
        }
    }
    fn lookup(dest: &&str) -> Option<u32> {
        match *dest {
            "intro" => Some(1),
            "method" | "method-a" => Some(3),
            "results" => Some(7),
            _ => None,
        }
    }
    fn outline() -> Vec<RawOutlineItem<&'static str>> {
        vec![
            item("1 Introduction", "intro", vec![]),
            item(
                "2 Method",
                "method",
                vec![item("2.1 Setup ", "method-a", vec![])],
            ),
            item("3 Results", "results", vec![]),
        ]
    }
    fn flat(title: &str, level: u32, page: u32) -> FlatOutlineItem {
        FlatOutlineItem {
            title: title.into(),
            level,
            page,
        }
    }

    #[test]
    fn flattens_depth_first_with_levels_trimming_titles() {
        assert_eq!(
            flatten_outline(&outline(), lookup),
            vec![
                flat("1 Introduction", 0, 1),
                flat("2 Method", 0, 3),
                flat("2.1 Setup", 1, 3),
                flat("3 Results", 0, 7)
            ]
        );
    }

    #[test]
    fn drops_unresolvable_dests_but_keeps_their_children() {
        let broken = vec![item(
            "Ghost",
            "missing",
            vec![item("Child", "results", vec![])],
        )];
        assert_eq!(flatten_outline(&broken, lookup), vec![flat("Child", 1, 7)]);
    }

    #[test]
    fn heading_for_page_is_the_exact_or_nearest_before() {
        let f = flatten_outline(&outline(), lookup);
        assert_eq!(heading_for_page(&f, 1), Some("1 Introduction"));
        assert_eq!(heading_for_page(&f, 2), Some("1 Introduction"));
        assert_eq!(heading_for_page(&f, 7), Some("3 Results"));
        assert_eq!(heading_for_page(&f, 20), Some("3 Results"));
        assert_eq!(heading_for_page(&f, 3), Some("2.1 Setup"));
        assert_eq!(heading_for_page(&f, 5), Some("2.1 Setup"));
    }

    #[test]
    fn heading_for_page_is_none_before_the_first_heading_or_with_no_outline() {
        let late = flatten_outline(&[item("Appendix", "results", vec![])], lookup);
        assert_eq!(heading_for_page(&late, 2), None);
        assert_eq!(heading_for_page(&[], 1), None);
    }

    #[test]
    fn section_index_at_is_the_last_heading_at_or_before() {
        let f = vec![
            flat("Intro", 0, 1),
            flat("Method", 0, 3),
            flat("Ablations", 1, 3),
            flat("Results", 0, 6),
        ];
        assert_eq!(section_index_at(&f, 1), Some(0));
        assert_eq!(section_index_at(&f, 4), Some(2));
        assert_eq!(section_index_at(&f, 9), Some(3));
        assert_eq!(section_index_at(&[flat("Late", 0, 2)], 1), None);
        assert_eq!(section_index_at(&[], 5), None);
    }

    #[test]
    fn top_level_keeps_the_shallowest_level_present() {
        let pdf = vec![
            flat("Intro", 0, 1),
            flat("Detail", 1, 2),
            flat("Results", 0, 5),
        ];
        assert_eq!(
            top_level(&pdf)
                .iter()
                .map(|s| s.title.as_str())
                .collect::<Vec<_>>(),
            ["Intro", "Results"]
        );
        let article = vec![
            flat("History", 2, 3),
            flat("Early work", 3, 4),
            flat("Variants", 2, 9),
        ];
        assert_eq!(
            top_level(&article)
                .iter()
                .map(|s| s.title.as_str())
                .collect::<Vec<_>>(),
            ["History", "Variants"]
        );
        assert!(top_level(&[]).is_empty());
    }
}

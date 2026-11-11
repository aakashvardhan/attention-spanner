//! Text out of XML (arXiv's Atom reply, RSS): entities undone.

use regex::Regex;
use std::sync::LazyLock;

static ENTITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|quot|apos|amp));").unwrap()
});

/// Collapse whitespace and undo the XML entities: the five named ones and any
/// numeric one (&#39;, &#x27;). One pass, so &amp;#39; stays &#39;.
pub(crate) fn unescape(raw: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undoes_named_and_numeric_entities_once_and_collapses_space() {
        assert_eq!(
            unescape("  A &lt;b&gt;\n &amp; &quot;c&quot; &apos;d&#39; &#x27;e  "),
            "A <b> & \"c\" 'd' 'e"
        );
        assert_eq!(unescape("&amp;#39;"), "&#39;");
        assert_eq!(unescape("&nbsp; &#xD800;"), "&nbsp; &#xD800;");
    }
}

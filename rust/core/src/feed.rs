//! An RSS feed (Hacker News front page) for the new tab.

use regex::Regex;
use std::sync::LazyLock;

pub const HN_RSS: &str = "https://news.ycombinator.com/rss";

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct FeedItem {
    pub title: String,
    pub link: String,
    /// The discussion page, when the feed has one.
    pub comments: Option<String>,
}

static ITEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<item>(.*?)</item>").unwrap());
static TAG: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    ["title", "link", "comments"]
        .map(|t| Regex::new(&format!(r"(?s)<{t}>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</{t}>")).unwrap())
});

/// RSS 2.0 → items, in feed order. Items without a title or link are dropped.
pub fn rss_items(xml: &str) -> Vec<FeedItem> {
    ITEM.captures_iter(xml)
        .filter_map(|c| {
            let body = c.get(1)?.as_str();
            let get = |i: usize| TAG[i].captures(body).map(|m| crate::xml::unescape(&m[1]));
            let (title, link) = (get(0)?, get(1)?);
            (!title.is_empty() && !link.is_empty()).then(|| FeedItem {
                title,
                link,
                comments: get(2),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_hn_items() {
        let xml = r#"<rss><channel><title>Hacker News</title><link>https://news.ycombinator.com/</link>
<item><title>Rust &amp; WASM</title><link>https://a.example/x</link><pubDate>Mon</pubDate><comments>https://news.ycombinator.com/item?id=1</comments><description><![CDATA[<a href="x">Comments</a>]]></description></item>
<item><title><![CDATA[Ask HN: why?]]></title><link>https://news.ycombinator.com/item?id=2</link></item>
<item><title></title><link>https://b.example</link></item>
</channel></rss>"#;
        let items = rss_items(xml);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "Rust & WASM");
        assert_eq!(
            items[0].comments.as_deref(),
            Some("https://news.ycombinator.com/item?id=1")
        );
        assert_eq!(items[1].title, "Ask HN: why?");
        assert_eq!(items[1].comments, None);
    }

    #[test]
    fn decodes_numeric_entities() {
        let xml = "<item><title>my car&#x27;s nav &#8212; &#39;hi&#39; &amp;#39;</title><link>https://a.example</link></item>";
        assert_eq!(rss_items(xml)[0].title, "my car's nav \u{2014} 'hi' &#39;");
    }
}

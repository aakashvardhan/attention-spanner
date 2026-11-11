//! AI answers as Markdown with LaTeX maths.
//!
//! Maths is lifted out before Markdown parsing, so `_`, `*` and `\` inside a
//! formula are not read as Markdown, then spliced back as whatever the
//! caller's renderer makes of it (KaTeX in the extension, a stub in tests).
//! Raw HTML is dropped and link/image targets are protocol-checked: the text
//! comes from a model and a paper, and renders in a page with chrome.* access.

use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};
use pulldown_cmark_escape::{escape_href, escape_html};

/// One formula: `display` for `$$…$$`, `\[…\]` and `\begin{env}…\end{env}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Math {
    pub display: bool,
    pub tex: String,
}

// Private-use characters: CommonMark turns NUL into U+FFFD, these pass through untouched.
const OPEN: char = '\u{E000}';
const CLOSE: char = '\u{E001}';

/// Length in bytes of the first char of `s`, if any.
fn first_len(s: &str) -> Option<usize> {
    s.chars().next().map(char::len_utf8)
}

/// `open` content `close`, content at least one character, shortest match.
/// Returns (bytes consumed, content).
fn delimited<'a>(rest: &'a str, open: &str, close: &str) -> Option<(usize, &'a str)> {
    let body = rest.strip_prefix(open)?;
    let from = first_len(body)?;
    let at = body[from..].find(close)? + from;
    Some((open.len() + at + close.len(), &body[..at]))
}

/// `$…$`: non-space just inside both delimiters, no newline, and not ending
/// in a dash, so "$5 and $10" and "$5–$10" stay prose.
fn inline_dollar(rest: &str) -> Option<(usize, &str)> {
    let body = rest.strip_prefix('$')?;
    let first = body.chars().next()?;
    if first.is_whitespace() || first == '$' {
        return None;
    }
    let end = body.find(['$', '\n'])?;
    if body.as_bytes()[end] == b'\n' {
        return None;
    }
    let content = &body[..end];
    let last = content.chars().next_back()?;
    if last.is_whitespace() || matches!(last, '–' | '—' | '-') {
        return None;
    }
    Some((end + 2, content))
}

/// `\begin{env}…\end{env}`, environment and all (KaTeX renders the environment).
fn environment(rest: &str) -> Option<(usize, &str)> {
    let after = rest.strip_prefix("\\begin{")?;
    let env = &after[..after.find('}')?];
    let name = env.strip_suffix('*').unwrap_or(env);
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_lowercase()) {
        return None;
    }
    let head = "\\begin{".len() + env.len() + 1;
    let end_tag = format!("\\end{{{env}}}");
    let from = head + first_len(&rest[head..])?;
    let at = rest[from..].find(&end_tag)? + from;
    let end = at + end_tag.len();
    Some((end, &rest[..end]))
}

/// The formula starting exactly at the front of `rest`, tried in the TS regex's order.
fn math_at(rest: &str) -> Option<(usize, Math)> {
    let display = |(n, tex): (usize, &str)| {
        (
            n,
            Math {
                display: true,
                tex: tex.to_string(),
            },
        )
    };
    let inline = |(n, tex): (usize, &str)| {
        (
            n,
            Math {
                display: false,
                tex: tex.to_string(),
            },
        )
    };
    environment(rest)
        .map(display)
        .or_else(|| delimited(rest, "$$", "$$").map(display))
        .or_else(|| delimited(rest, "\\[", "\\]").map(display))
        .or_else(|| delimited(rest, "\\(", "\\)").map(inline))
        .or_else(|| inline_dollar(rest).map(inline))
}

/// The text with every formula swapped for a placeholder, and the formulas.
pub fn lift_math(text: &str) -> (String, Vec<Math>) {
    let (out, found) = lift(text);
    (out, found.into_iter().map(|(m, _)| m).collect())
}

/// `lift_math`, keeping each formula's source text, delimiters and all.
fn lift(text: &str) -> (String, Vec<(Math, &str)>) {
    let mut out = String::with_capacity(text.len());
    let mut found = Vec::new();
    let mut i = 0;
    while let Some(c) = text[i..].chars().next() {
        if c == '$' || c == '\\' {
            if let Some((n, m)) = math_at(&text[i..]) {
                out.push(OPEN);
                out.push_str(&found.len().to_string());
                out.push(CLOSE);
                found.push((m, &text[i..i + n]));
                i += n;
                continue;
            }
        }
        out.push(c);
        i += c.len_utf8();
    }
    (out, found)
}

/// The placeholders in `s` put back as the source text they stand for. An
/// attribute (a URL, a title, an image's alt text) cannot hold rendered maths.
fn restore<'a>(s: &'a str, raw: &[&str]) -> CowStr<'a> {
    if !s.contains(OPEN) {
        return CowStr::Borrowed(s);
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find(OPEN) {
        out.push_str(&rest[..open]);
        let after = &rest[open + OPEN.len_utf8()..];
        let found = after.find(CLOSE).and_then(|close| {
            let n: usize = after[..close].parse().ok()?;
            Some((raw.get(n)?, close))
        });
        match found {
            Some((text, close)) => {
                out.push_str(text);
                rest = &after[close + CLOSE.len_utf8()..];
            }
            None => {
                out.push(OPEN);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    CowStr::from(out)
}

/// Unicode KaTeX has no symbol for, as the LaTeX it meant. Greek, arrows,
/// ≤ ≥ ≈ ≠ ±, °, ×, ∞ and · pass through: KaTeX knows those.
pub(crate) fn normalize_tex(tex: &str) -> String {
    let mut out = String::with_capacity(tex.len());
    for c in tex.chars() {
        match c {
            '‐' | '–' | '—' => out.push('-'),
            '‘' | '’' | '′' => out.push('\''),
            // \text so it is not read as a double prime
            '“' | '”' => out.push_str("\\text{\"}"),
            '\u{a0}' | '\u{2009}' => out.push(' '),
            // Braced: "5µm" would otherwise become the undefined command \mum.
            'µ' => out.push_str("{\\mu}"),
            c => out.push(c),
        }
    }
    out
}

/// The only protocols allowed to reach an href or src.
fn safe(href: &str) -> bool {
    let h = href.trim_start().to_ascii_lowercase();
    h.starts_with("http:") || h.starts_with("https:") || h.starts_with("mailto:")
}

/// Markdown and maths to HTML. `render_math(tex, display)` gets the
/// normalised formula; `None` shows it verbatim instead.
pub fn render_markdown(
    text: &str,
    mut render_math: impl FnMut(&str, bool) -> Option<String>,
) -> String {
    if text.is_empty() {
        return String::new();
    }
    let (staged, lifted) = lift(text);
    let raw: Vec<&str> = lifted.iter().map(|(_, r)| *r).collect();
    let math: Vec<Math> = lifted.into_iter().map(|(m, _)| m).collect();
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    // Whether each open link/image was kept, so its end tag matches.
    let mut links = Vec::new();
    let mut images = Vec::new();
    let events = Parser::new_ext(&staged, options).filter_map(|e| match e {
        Event::Html(_) | Event::InlineHtml(_) => None,
        // Single newlines are line breaks, as a chat answer means them.
        Event::SoftBreak => Some(Event::HardBreak),
        // A kept image's text is its alt attribute: formulas stay as typed.
        Event::Text(t) if images.last() == Some(&true) => {
            Some(Event::Text(restore(&t, &raw).into_string().into()))
        }
        Event::Code(t) if images.last() == Some(&true) => {
            Some(Event::Code(restore(&t, &raw).into_string().into()))
        }
        Event::Start(Tag::Link {
            dest_url, title, ..
        }) => {
            let (dest_url, title) = (restore(&dest_url, &raw), restore(&title, &raw));
            let keep = safe(&dest_url);
            links.push(keep);
            keep.then(|| {
                let mut a = String::from("<a href=\"");
                let _ = escape_href(&mut a, &dest_url);
                a.push('"');
                if !title.is_empty() {
                    a.push_str(" title=\"");
                    let _ = escape_html(&mut a, &title);
                    a.push('"');
                }
                // Extension pages have nowhere to go back to; no window.opener for the new page.
                a.push_str(" target=\"_blank\" rel=\"noopener noreferrer\">");
                Event::Html(CowStr::from(a))
            })
        }
        Event::End(TagEnd::Link) => links
            .pop()
            .unwrap_or(false)
            .then(|| Event::Html(CowStr::from("</a>"))),
        // An unsafe image degrades to its alt text: the inner text events render as body text.
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => {
            let dest_url = restore(&dest_url, &raw).into_string();
            let keep = safe(&dest_url);
            images.push(keep);
            keep.then(|| {
                Event::Start(Tag::Image {
                    link_type,
                    dest_url: dest_url.into(),
                    title: restore(&title, &raw).into_string().into(),
                    id,
                })
            })
        }
        Event::End(TagEnd::Image) => images.pop().unwrap_or(false).then_some(e),
        e => Some(e),
    });
    let mut out = String::new();
    html::push_html(&mut out, events);

    // Splice the formulas back over their placeholders.
    let mut result = String::with_capacity(out.len());
    let mut rest = out.as_str();
    while let Some(open) = rest.find(OPEN) {
        result.push_str(&rest[..open]);
        let after = &rest[open + OPEN.len_utf8()..];
        let Some(close) = after.find(CLOSE) else {
            rest = after;
            continue;
        };
        if let Some(m) = after[..close]
            .parse::<usize>()
            .ok()
            .and_then(|n| math.get(n))
        {
            let shown = render_math(&normalize_tex(&m.tex), m.display).unwrap_or_else(|| {
                let d = if m.display { "$$" } else { "$" };
                let mut s = String::new();
                let _ = escape_html(&mut s, &format!("{d}{}{d}", m.tex));
                s
            });
            result.push_str(&shown);
        }
        rest = &after[close + CLOSE.len_utf8()..];
    }
    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// KaTeX's class names, so the assertions read like the TS ones.
    fn fake(tex: &str, display: bool) -> Option<String> {
        if tex.contains("\\frac{1}{") && !tex.ends_with('}') {
            return None;
        }
        let span = format!("<span class=\"katex\">{tex}</span>");
        Some(if display {
            format!("<span class=\"katex-display\">{span}</span>")
        } else {
            span
        })
    }
    fn md(text: &str) -> String {
        render_markdown(text, fake)
    }

    #[test]
    fn renders_markdown_structure() {
        let html = md("## Heading\n\n- one\n- two\n\n**bold** and `code`");
        assert!(html.contains("<h2"));
        assert!(html.contains("<li>one</li>"));
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<code>code</code>"));
    }

    #[test]
    fn renders_inline_and_display_math() {
        let html = md("The gradient $\\nabla f$ points uphill.");
        assert!(html.contains("class=\"katex\""));
        assert!(!html.contains('$'));
        assert!(md("Energy:\n\n$$E = mc^2$$").contains("katex-display"));
        assert!(md("A \\[x\\] and \\(y\\)").contains("katex-display"));
    }

    #[test]
    fn renders_a_bare_environment_as_display_math() {
        let html = md("Loss:\n\n\\begin{equation}L = \\sum_i x_i^2\\end{equation}");
        assert!(html.contains("katex-display"));
        assert!(html.contains("\\begin{equation}"));
    }

    #[test]
    fn keeps_markdown_characters_inside_math() {
        let html = md("$a_i^2 + b_i^2$");
        assert!(html.contains("class=\"katex\""));
        assert!(!html.contains("<em>"));
    }

    #[test]
    fn currency_and_price_ranges_are_not_math() {
        let html = md("It costs $5 and then $10 more.");
        assert!(!html.contains("katex"));
        assert!(html.contains("$5") && html.contains("$10"));
        for dash in ['–', '—', '-'] {
            let html = md(&format!("Priced $5{dash}$10, or $20{dash}$30."));
            assert!(!html.contains("katex"), "{dash}");
            assert!(html.contains(&format!("$5{dash}$10")));
            assert!(html.contains(&format!("$20{dash}$30")));
        }
        assert!(md("The range $1–5$ is inclusive.").contains("class=\"katex\""));
    }

    #[test]
    fn drops_raw_html() {
        let html = md("hi <img src=x onerror=alert(1)> there");
        assert!(!html.contains("<img") && !html.contains("onerror"));
    }

    #[test]
    fn drops_javascript_links_keeping_their_text() {
        let html = md("[click me](javascript:alert(1))");
        assert!(!html.contains("javascript:") && !html.contains("<a"));
        assert!(html.contains("click me"));
        let r = md("[a][r]\n\n[r]: javascript:alert(1)");
        assert!(!r.contains("javascript:") && !r.contains("<a"));
        let img = md("![alt text](javascript:alert(1))");
        assert!(!img.contains("javascript:") && !img.contains("<img"));
        assert!(img.contains("alt text"));
    }

    #[test]
    fn keeps_http_links_without_an_opener() {
        let html = md("[arxiv](https://arxiv.org/abs/1706.03762)");
        assert!(html.contains("href=\"https://arxiv.org/abs/1706.03762\""));
        assert!(html.contains("rel=\"noopener noreferrer\""));
        assert!(html.contains(">arxiv</a>"));
        let html = md("[**bold** link](https://example.com)");
        assert!(html.contains("<strong>bold</strong>"));
        assert!(md("![a](https://example.com/x.png)")
            .contains("<img src=\"https://example.com/x.png\""));
    }

    #[test]
    fn urls_cannot_break_out_of_the_attribute() {
        let html = md("[x](<https://a.example/\" onmouseover=\"alert(1)>)");
        assert!(!html.contains("onmouseover=\""));
        assert!(html.contains("%22"));
        assert!(md("[x](https://a.example/a%20b)").contains("href=\"https://a.example/a%20b\""));
    }

    #[test]
    fn maths_inside_a_link_or_image_attribute_stays_as_typed() {
        let html = md("[x](https://a.example/$b$)");
        assert!(html.contains("href=\"https://a.example/$b$\""), "{html}");
        assert!(!html.contains("%EE%80"));
        let html = md("[$x$ link](https://a.example/ \"cost $y$\")");
        assert!(html.contains("title=\"cost $y$\""), "{html}");
        assert!(
            html.contains("<span class=\"katex\">x</span> link</a>"),
            "{html}"
        );
        let img = md("![plot of $f(x)$](https://a.example/$p$.png)");
        assert!(img.contains("src=\"https://a.example/$p$.png\""), "{img}");
        assert!(img.contains("alt=\"plot of $f(x)$\""), "{img}");
        assert!(!img.contains("katex"));
    }

    #[test]
    fn malformed_math_shows_verbatim_with_the_prose() {
        let html = md("before $\\frac{1}{$ after");
        assert!(html.contains("before") && html.contains("after"));
        assert!(html.contains("$\\frac{1}{$"));
    }

    #[test]
    fn empty_is_empty() {
        assert_eq!(md(""), "");
    }

    #[test]
    fn maps_the_unicode_katex_lacks() {
        assert_eq!(normalize_tex("1–5"), "1-5");
        assert_eq!(normalize_tex("1—5"), "1-5");
        assert_eq!(normalize_tex("f’(x)"), "f'(x)");
        assert_eq!(normalize_tex("x′"), "x'");
        assert_eq!(normalize_tex("a\u{a0}b"), "a b");
        assert_eq!(normalize_tex("5µm"), "5{\\mu}m");
        for tex in ["α≤β", "a×b", "∞→0", "a−b", "90°", "x·y"] {
            assert_eq!(normalize_tex(tex), tex);
        }
    }

    #[test]
    fn the_renderer_sees_normalised_tex() {
        let mut seen = vec![];
        render_markdown("Ranges $1–5$ and $f’(x)$, scale $5µm$.", |t, _| {
            seen.push(t.to_string());
            Some(String::new())
        });
        assert_eq!(seen, ["1-5", "f'(x)", "5{\\mu}m"]);
    }

    #[test]
    fn a_definition_renders_bold_term_then_text() {
        let html = md("**Transformer**: an attention-based sequence model.");
        assert_eq!(
            html,
            "<p><strong>Transformer</strong>: an attention-based sequence model.</p>\n"
        );
    }
}

//! The reader's audiobook: the paper read aloud page by page, as narration,
//! not recitation. Haiku turns each page's text into something a listener
//! can follow (math explained, citations and page furniture dropped), then
//! Groq Orpheus speaks it (voice_agent's chunking and tightening).

use crate::voice_agent::Source;

/// What Haiku answers for a page with nothing worth hearing.
pub const SKIP: &str = "[SKIP]";
/// How much of the previous page is given, so a sentence split across pages reads on.
const TAIL_CHARS: usize = 400;
/// Past this a page's text is cut (a dense two-column page is ~6k).
const PAGE_MAX_CHARS: usize = 12_000;

pub fn narrate_system(title: &str, source: Source) -> String {
    let (what, unit, read_math, skip_when) = match source {
        Source::Paper => (
            format!("one page of the research paper \"{title}\""),
            "page",
            "You get the page twice: as a picture of the printed page, and as text extracted \
from the PDF. The text scrambles math (sub- and superscripts land on their own lines, \
fractions come apart), so read every equation, symbol and formula from the picture, and use \
the text for the wording of the prose.",
            "the reference list or acknowledgements",
        ),
        // A video has no Listen; its notes would read as a page.
        Source::Webpage | Source::Video => (
            format!("one section of the web page \"{title}\""),
            "section",
            "Math arrives as LaTeX between $ or $$ signs; read it from that, and never say \
the LaTeX aloud.",
            "navigation, comments, a reference list or acknowledgements",
        ),
    };
    format!(
        "You turn {what} into narration for someone who is \
listening instead of reading, like a knowledgeable friend reading it aloud. Keep the {unit}'s \
content and order, mostly in the authors' own words, but make it sound spoken: join lines \
broken by the layout, undo hyphenation, and drop citation markers like [12] or (Smith et al., \
2020), footnote marks, page numbers, running headers and URLs. Never read math symbol by \
symbol. For every equation, formula or notation-heavy passage, say in one to three plain \
sentences what it computes or claims and what each part does, naming the parts by their role \
in the text. For example: \"this is the training loss: for every token, it takes the log of \
the probability the model gave the right next word, and averages that over the batch.\" \
{read_math} When a symbol is defined elsewhere and not here, \
name its role from context rather than guessing a definition. For a proof, a derivation or \
a theorem: first say what is being claimed, in plain words; then the overall strategy; then \
walk through each step as a move (\"bound this term by that one\", \"substitute the definition \
of the loss\", \"sum over all tokens\"), saying why it is allowed when the text says so, and \
point out the key trick. Never skip a step silently, and never read a proof line by line in \
symbols. For a table, say what it compares and the takeaway the text draws from it; \
for a figure caption, one sentence on what the figure shows. Say section headings as \
\"Section three: Method.\" The {unit} may begin or end mid-sentence: pick up smoothly from the \
end of the previous {unit}, which you are given, and stop where this {unit} stops. Add nothing \
the {unit} does not say, beyond explaining the math, and do not summarise or give opinions. \
Plain text only: no markdown, no LaTeX, no lists, no emoji, no bracketed tags. Never address the \
listener, comment on what you were given, or ask for anything: you only narrate. If the {unit} \
is only {skip_when}, or there is nothing to narrate (a lone date, title or byline), reply with \
exactly {SKIP}."
    )
}

/// The page's text, capped.
pub fn page_document(text: &str) -> String {
    text.chars().take(PAGE_MAX_CHARS).collect()
}

/// Which page or section this is, and how the previous one ended.
pub fn narrate_prompt(n: u32, count: u32, previous: Option<&str>, source: Source) -> String {
    let part = source.part();
    let mut out = format!("This is {part} {n} of {count}.");
    match previous.map(tail) {
        Some(t) if !t.is_empty() => {
            out.push_str(&format!(" The previous {part} ended: \""));
            out.push_str(&t);
            out.push('"');
        }
        _ => out.push_str(" It is where the listener starts."),
    }
    out.push_str(&format!(" Narrate this {part}."));
    out
}

fn tail(text: &str) -> String {
    let t = text.trim();
    let n = t.chars().count();
    t.chars().skip(n.saturating_sub(TAIL_CHARS)).collect()
}

/// Haiku is skipping this page (or is about to: the marker may still be streaming).
pub fn is_skip(so_far: &str) -> bool {
    let t = so_far.trim_start();
    !t.is_empty() && (t.starts_with(SKIP) || SKIP.starts_with(t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_carries_the_page_and_how_the_last_one_ended() {
        let p = narrate_prompt(
            3,
            12,
            Some("…and so the model is trained with the"),
            Source::Paper,
        );
        assert!(p.contains("page 3 of 12") && p.contains("trained with the\""));
        assert!(narrate_prompt(1, 12, None, Source::Paper).contains("where the listener starts"));
        let long = "x".repeat(1000) + "END";
        assert!(narrate_prompt(2, 2, Some(&long), Source::Paper).contains("END\""));
        assert!(narrate_prompt(2, 2, Some(&long), Source::Paper).len() < 600);
        let sys = narrate_system("T", Source::Paper);
        assert!(
            sys.contains("Never read math symbol by symbol") && sys.contains("from the picture")
        );
        assert!(sys.contains("For a proof"));
    }

    #[test]
    fn webpage_narration_reads_latex_not_a_picture() {
        let sys = narrate_system("Agent evaluation", Source::Webpage);
        assert!(sys.contains("web page") && sys.contains("LaTeX"));
        assert!(!sys.contains("picture") && !sys.contains("research paper"));
        assert!(sys.contains("Never read math symbol by symbol") && sys.contains("For a proof"));
        assert!(narrate_prompt(2, 5, None, Source::Webpage).contains("section 2 of 5"));
    }

    #[test]
    fn narration_never_talks_to_the_listener() {
        for source in [Source::Paper, Source::Webpage] {
            let sys = narrate_system("T", source);
            assert!(sys.contains("Never address the listener"), "{source:?}");
            assert!(sys.contains("nothing to narrate"), "{source:?}");
        }
    }

    #[test]
    fn spots_a_skip_even_while_it_streams_in() {
        assert!(is_skip("[SKIP]") && is_skip("  [SK") && is_skip("["));
        assert!(!is_skip("") && !is_skip("Section three: Method.") && !is_skip("[12] shows"));
    }
}

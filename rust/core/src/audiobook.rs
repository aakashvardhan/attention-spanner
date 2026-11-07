//! The reader's audiobook: the paper read aloud page by page, as narration,
//! not recitation. Haiku turns each page's text into something a listener
//! can follow (math explained, citations and page furniture dropped), then
//! Groq Orpheus speaks it (voice_agent's chunking and tightening).

/// What Haiku answers for a page with nothing worth hearing.
pub const SKIP: &str = "[SKIP]";
/// How much of the previous page is given, so a sentence split across pages reads on.
const TAIL_CHARS: usize = 400;
/// Past this a page's text is cut (a dense two-column page is ~6k).
const PAGE_MAX_CHARS: usize = 12_000;

pub fn narrate_system(title: &str) -> String {
    format!(
        "You turn one page of the research paper \"{title}\" into narration for someone who is \
listening instead of reading, like a knowledgeable friend reading it aloud. Keep the page's \
content and order, mostly in the authors' own words, but make it sound spoken: join lines \
broken by the layout, undo hyphenation, and drop citation markers like [12] or (Smith et al., \
2020), footnote marks, page numbers, running headers and URLs. Never read math symbol by \
symbol. For every equation, formula or notation-heavy passage, say in one to three plain \
sentences what it computes or claims and what each part does, naming the parts by their role \
in the paper. For example: \"this is the training loss: for every token, it takes the log of \
the probability the model gave the right next word, and averages that over the batch.\" You get \
the page twice: as a picture of the printed page, and as text extracted from the PDF. The \
text scrambles math (sub- and superscripts land on their own lines, fractions come apart), \
so read every equation, symbol and formula from the picture, and use the text for the \
wording of the prose. When a symbol is defined elsewhere in the paper and not on this page, \
name its role from context rather than guessing a definition. For a proof, a derivation or \
a theorem: first say what is being claimed, in plain words; then the overall strategy; then \
walk through each step as a move (\"bound this term by that one\", \"substitute the definition \
of the loss\", \"sum over all tokens\"), saying why it is allowed when the page says so, and \
point out the key trick. Never skip a step silently, and never read a proof line by line in \
symbols. For a table, say what it compares and the takeaway the text draws from it; \
for a figure caption, one sentence on what the figure shows. Say section headings as \
\"Section three: Method.\" The page may begin or end mid-sentence: pick up smoothly from the \
end of the previous page, which you are given, and stop where this page stops. Add nothing the \
page does not say, beyond explaining the math, and do not summarise or give opinions. Plain \
text only: no markdown, no LaTeX, no lists, no emoji, no bracketed tags. If the page is only \
the reference list or acknowledgements, reply with exactly {SKIP}."
    )
}

/// The page's text, capped.
pub fn page_document(text: &str) -> String {
    text.chars().take(PAGE_MAX_CHARS).collect()
}

/// Which page this is, and how the previous one ended.
pub fn narrate_prompt(page: u32, page_count: u32, previous: Option<&str>) -> String {
    let mut out = format!("This is page {page} of {page_count}.");
    match previous.map(tail) {
        Some(t) if !t.is_empty() => {
            out.push_str(" The previous page ended: \"");
            out.push_str(&t);
            out.push('"');
        }
        _ => out.push_str(" It is where the listener starts."),
    }
    out.push_str(" Narrate this page.");
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
        let p = narrate_prompt(3, 12, Some("…and so the model is trained with the"));
        assert!(p.contains("page 3 of 12") && p.contains("trained with the\""));
        assert!(narrate_prompt(1, 12, None).contains("where the listener starts"));
        let long = "x".repeat(1000) + "END";
        assert!(narrate_prompt(2, 2, Some(&long)).contains("END\""));
        assert!(narrate_prompt(2, 2, Some(&long)).len() < 600);
        let sys = narrate_system("T");
        assert!(
            sys.contains("Never read math symbol by symbol") && sys.contains("from the picture")
        );
        assert!(sys.contains("For a proof"));
    }

    #[test]
    fn spots_a_skip_even_while_it_streams_in() {
        assert!(is_skip("[SKIP]") && is_skip("  [SK") && is_skip("["));
        assert!(!is_skip("") && !is_skip("Section three: Method.") && !is_skip("[12] shows"));
    }
}

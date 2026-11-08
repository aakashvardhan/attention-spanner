//! YouTube in the side panel: which video a URL is, its timestamps, and the
//! Gemini request that turns a video into takeaways shaped to its kind.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The Gemini model for video notes and Talk (listed "Stable", 2026-11-07).
pub const GEMINI_MODEL: &str = "gemini-3.6-flash";

pub fn gemini_url() -> String {
    format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
    )
}

/// The 11-character id of a YouTube video URL; None for any other page.
pub fn video_id(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    let host = url.host_str()?;
    let yt = ["youtube.com", "youtube-nocookie.com"]
        .iter()
        .any(|d| host == *d || host.ends_with(&format!(".{d}")));
    let id = if host == "youtu.be" {
        url.path_segments()?.next().map(String::from)
    } else if yt {
        let mut seg = url.path_segments()?;
        match seg.next()? {
            "watch" => url
                .query_pairs()
                .find(|(k, _)| k == "v")
                .map(|(_, v)| v.into_owned()),
            "shorts" | "embed" | "live" => seg.next().map(String::from),
            _ => None,
        }
    } else {
        None
    }?;
    // An embedded playlist's "id" is the word videoseries: not a video.
    let ok = id != "videoseries"
        && id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(id)
}

/// The video's plain watch URL: what Gemini is given and what is stored,
/// whatever shape (shorts, youtu.be, a playlist, a start time) it was opened in.
pub fn watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}

/// `MM:SS`, `M:SS` or `H:MM:SS` to seconds.
pub fn seconds(t: &str) -> Option<u32> {
    let parts: Vec<&str> = t.trim().split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut total = 0u32;
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let n: u32 = p.parse().ok()?;
        // Minutes and seconds after the first field are two digits, under 60.
        if i > 0 && (p.len() != 2 || n >= 60) {
            return None;
        }
        total = total.checked_mul(60)?.checked_add(n)?;
    }
    Some(total)
}

/// Seconds as `M:SS`, or `H:MM:SS` from an hour on.
pub fn stamp(secs: u32) -> String {
    let (h, m, s) = (secs / 3600, secs / 60 % 60, secs % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    #[default]
    Lecture,
    Tutorial,
    Educational,
}

impl Kind {
    pub const ALL: [Kind; 3] = [Kind::Lecture, Kind::Tutorial, Kind::Educational];

    pub fn label(self) -> &'static str {
        match self {
            Kind::Lecture => "Lecture",
            Kind::Tutorial => "Tutorial",
            Kind::Educational => "Educational",
        }
    }

    fn word(self) -> &'static str {
        match self {
            Kind::Lecture => "lecture",
            Kind::Tutorial => "tutorial",
            Kind::Educational => "educational",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Stamped {
    #[serde(default)]
    pub t: String,
    #[serde(default, alias = "q")]
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Step {
    #[serde(default)]
    pub t: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub gotcha: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Idea {
    #[serde(default)]
    pub t: String,
    #[serde(default)]
    pub idea: String,
    #[serde(default)]
    pub intuition: String,
}

/// A video's takeaways, as stored under `videoNotes[id]`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoNotes {
    pub id: String,
    pub url: String,
    pub title: String,
    pub kind: Kind,
    pub summary: String,
    /// Lecture: Cornell cue questions.
    pub cues: Vec<Stamped>,
    /// Lecture: the notes column.
    pub notes: Vec<Stamped>,
    pub prerequisites: Vec<String>,
    pub steps: Vec<Step>,
    /// Educational: the central question.
    pub question: String,
    pub ideas: Vec<Idea>,
    pub created_at: i64,
    /// The parts of the video these notes cover, in time order; empty = all
    /// of it. (Named `sections`: a `parts` field of pairs was stored briefly.)
    pub sections: Vec<Section>,
}

/// One part of a video taken on its own: its range in seconds and its summary
/// (the notes' own summary stays empty).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Section {
    pub from: u32,
    pub to: u32,
    pub summary: String,
}

impl Section {
    pub fn range(&self) -> String {
        format!("{}–{}", stamp(self.from), stamp(self.to))
    }
}

/// Sectioned notes split by part, each part's items in time order; an item
/// goes to the last part starting at or before it (the first, without a time).
/// Prerequisites and the question go with the first part. Empty when the
/// notes cover the whole video.
pub fn group(n: &VideoNotes) -> Vec<(Section, VideoNotes)> {
    let at = |t: &str| {
        let secs = seconds(t).unwrap_or(0);
        n.sections.iter().rposition(|s| s.from <= secs).unwrap_or(0)
    };
    fn pick<T: Clone>(
        items: &[T],
        t: impl Fn(&T) -> &str,
        i: usize,
        at: &impl Fn(&str) -> usize,
    ) -> Vec<T> {
        let mut v: Vec<T> = items.iter().filter(|x| at(t(x)) == i).cloned().collect();
        v.sort_by_key(|x| seconds(t(x)).unwrap_or(0));
        v
    }
    n.sections
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let first = i == 0;
            let sub = VideoNotes {
                id: n.id.clone(),
                kind: n.kind,
                summary: s.summary.clone(),
                cues: pick(&n.cues, |x| &x.t, i, &at),
                notes: pick(&n.notes, |x| &x.t, i, &at),
                steps: pick(&n.steps, |x| &x.t, i, &at),
                ideas: pick(&n.ideas, |x| &x.t, i, &at),
                prerequisites: if first {
                    n.prerequisites.clone()
                } else {
                    vec![]
                },
                question: if first {
                    n.question.clone()
                } else {
                    String::new()
                },
                ..Default::default()
            };
            (s.clone(), sub)
        })
        .collect()
}

/// The longest stretch Gemini is asked to watch at once. Measured 2026-11-08:
/// a 2 h video took 65 s; a 25 h one failed with a bare 500.
pub const CLIP_MAX: u32 = 2 * 3600;

/// The part to watch from the From/To fields (empty From = the start, empty
/// To = the end): None for the whole video, or why it can't be asked for.
pub fn clip(from: &str, to: &str, length: u32) -> Result<Option<(u32, u32)>, String> {
    let read = |t: &str, name: &str| match t.trim() {
        "" => Ok(None),
        t => seconds(t)
            .map(Some)
            .ok_or_else(|| format!("{name} isn't a time like 1:02:03.")),
    };
    let (f, t) = (read(from, "From")?, read(to, "To")?);
    let start = f.unwrap_or(0);
    let end = match (t, length) {
        (Some(t), 0) => t,
        (Some(t), l) => t.min(l),
        (None, 0) if start == 0 => return Ok(None),
        (None, 0) => return Err("Set To as well: the video's length isn't known.".into()),
        (None, l) => l,
    };
    if f.is_none() && t.is_none() && length <= CLIP_MAX {
        return Ok(None);
    }
    if end <= start {
        return Err("To must come after From.".into());
    }
    if end - start > CLIP_MAX {
        return Err(format!(
            "That part is {} long. Gemini watches up to {} at a time: set From and To.",
            stamp(end - start),
            stamp(CLIP_MAX)
        ));
    }
    Ok(Some((start, end)))
}

/// The chapters a description lists: `(seconds, label)` for each line with a
/// timestamp ("1:02:03 Attention", "Intro - 0:00", "(12:30) Q&A"), in order.
pub fn chapters(description: &str) -> Vec<(u32, String)> {
    let mut out: Vec<(u32, String)> = description
        .lines()
        .filter_map(|line| {
            let words: Vec<&str> = line.split_whitespace().collect();
            let trim = |w: &str| w.trim_matches(|c: char| !c.is_ascii_digit()).to_string();
            let i = words.iter().position(|w| seconds(&trim(w)).is_some())?;
            let secs = seconds(&trim(words[i]))?;
            let mut rest = words.clone();
            rest.remove(i);
            let label = rest
                .join(" ")
                .trim_matches(|c: char| c.is_whitespace() || "-–—:|•()[]".contains(c))
                .to_string();
            Some((secs, label))
        })
        .collect();
    out.sort_by_key(|c| c.0);
    out.dedup_by_key(|c| c.0);
    out
}

/// A newly made part added to the notes already kept for the video: lists
/// and sections appended. The kept title and shape stay.
pub fn merge(mut old: VideoNotes, new: VideoNotes) -> VideoNotes {
    old.cues.extend(new.cues);
    old.notes.extend(new.notes);
    old.steps.extend(new.steps);
    old.ideas.extend(new.ideas);
    for p in new.prerequisites {
        if !old.prerequisites.contains(&p) {
            old.prerequisites.push(p);
        }
    }
    if old.question.is_empty() {
        old.question = new.question;
    }
    old.sections.extend(new.sections);
    old.sections.sort_by_key(|s| s.from);
    old.created_at = new.created_at;
    old
}

/// Longer than this, a "title" is notes in the wrong field.
const TITLE_MAX: usize = 150;

fn schema() -> Value {
    let s = json!({ "type": "string" });
    let t = json!({ "type": "string", "description": "MM:SS, or H:MM:SS past an hour" });
    let list = |props: Value, req: &[&str]| json!({ "type": "array", "items": { "type": "object", "properties": props, "required": req } });
    json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "enum": ["lecture", "tutorial", "educational"] },
            "title": { "type": "string", "maxLength": TITLE_MAX },
            "summary": s,
            "cues": list(json!({ "t": t, "text": s }), &["t", "text"]),
            "notes": list(json!({ "t": t, "text": s }), &["t", "text"]),
            "prerequisites": { "type": "array", "items": s },
            "steps": list(json!({ "t": t, "text": s, "code": s, "gotcha": s }), &["t", "text"]),
            "question": s,
            "ideas": list(json!({ "t": t, "idea": s, "intuition": s }), &["t", "idea", "intuition"])
        },
        // Every field, in the order to write them: shape first, title last.
        // (With only kind/title/summary required Gemini once wrote a whole
        // lecture into the title and left the lists empty.)
        "required": ["kind", "question", "prerequisites", "cues", "notes", "steps", "ideas", "summary", "title"]
    })
}

const SHAPES: &str = "Shapes. lecture: Cornell notes; cues are the questions a student would \
quiz themselves with, each with the timestamp it is answered at; notes are timestamped notes in \
order; summary is three to five sentences. tutorial: prerequisites; steps in order, each with its \
timestamp, the exact commands or code shown on screen in `code` (copied exactly, empty if none) and \
any warning the presenter gives in `gotcha`; summary is one sentence on what you end up with. \
educational: question is the central question the video asks; ideas are the key ideas in order, \
each with its timestamp and the intuition, picture or example the video uses for it; summary is \
the so-what in two or three sentences. Timestamps are MM:SS (H:MM:SS past an hour) and must be \
real moments in the video. Fill only the chosen shape's fields; leave the others empty. Plain \
text in every field: no markdown.";

/// The request that watches the video and writes its notes. `kind` forces a
/// shape (the reader switched it); None lets Gemini decide. `clip` is the
/// part to watch, in seconds; None is the whole video.
pub fn notes_request(url: &str, kind: Option<Kind>, clip: Option<(u32, u32)>) -> Value {
    let mut ask = match kind {
        None => format!("Decide whether this video is a lecture, a tutorial or an educational explainer, set kind, and write its takeaways in that kind's shape. {SHAPES}"),
        Some(k) => format!("Write this video's takeaways as a {w}: set kind to {w}. {SHAPES}", w = k.word()),
    };
    let mut video = json!({ "file_data": { "file_uri": url } });
    if let Some((from, to)) = clip {
        // Live 2026-11-08: timestamps in a clip's notes count from the video's start.
        video["video_metadata"] =
            json!({ "start_offset": format!("{from}s"), "end_offset": format!("{to}s") });
        ask.push_str(&format!(
            " You are given only the part from {} to {}: take notes on that part alone.",
            stamp(from),
            stamp(to)
        ));
    }
    json!({
        "contents": [{ "parts": [
            video,
            { "text": ask }
        ] }],
        "generationConfig": { "responseMimeType": "application/json", "responseJsonSchema": schema() }
    })
}

/// The reply's text: the last text part of the first candidate.
fn reply_text(v: &Value) -> Result<String, String> {
    if let Some(m) = v["error"]["message"].as_str() {
        return Err(format!("Gemini: {m}"));
    }
    if let Some(r) = v["promptFeedback"]["blockReason"].as_str() {
        return Err(format!("Gemini declined this video ({r})."));
    }
    v["candidates"][0]["content"]["parts"]
        .as_array()
        .and_then(|p| p.iter().rev().find_map(|p| p["text"].as_str()))
        .map(String::from)
        .ok_or_else(|| "Gemini sent no notes.".to_string())
}

/// A generateContent reply as notes for this video.
pub fn parse_notes(
    body: &str,
    id: &str,
    url: &str,
    title: &str,
    now: i64,
) -> Result<VideoNotes, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| "Gemini's reply came back unreadable.".to_string())?;
    let text = reply_text(&v)?;
    let mut n: VideoNotes = serde_json::from_str(&text)
        .map_err(|_| "Gemini's notes came back unreadable.".to_string())?;
    let empty = match n.kind {
        Kind::Lecture => n.notes.is_empty() && n.cues.is_empty(),
        Kind::Tutorial => n.steps.is_empty(),
        Kind::Educational => n.ideas.is_empty(),
    };
    if empty {
        return Err("Gemini's notes came back empty. Try again.".into());
    }
    n.id = id.into();
    n.url = url.into();
    if n.title.trim().is_empty() || n.title.chars().count() > TITLE_MAX {
        n.title = title.into();
    }
    n.created_at = now;
    Ok(n)
}

/// A Talk reply's text.
pub fn parse_reply(body: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(body)
        .map_err(|_| "Gemini's reply came back unreadable.".to_string())?;
    reply_text(&v)
}

/// A failed call, in words.
pub fn gemini_error(status: u16, body: &str) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_lowercase))
        .unwrap_or_default();
    if msg.contains("api key") || status == 401 || status == 403 && msg.contains("key") {
        "The Gemini key in Settings isn't valid.".into()
    } else if status == 429 {
        "Gemini's usage limit is reached (per minute or per day). Try again later.".into()
    } else if msg.contains("token") {
        "This video is too long for Gemini in one go.".into()
    } else if msg.contains("video") || msg.contains("url") || msg.contains("fetch") {
        "Gemini can't open this video (it may be private or unavailable).".into()
    } else if status == 500 {
        // A video past Gemini's ~1M-token window (a few hours) comes back as
        // a bare 500, not a token error.
        "Gemini failed (500). Videos longer than a few hours are too long for it; otherwise try again.".into()
    } else {
        format!("Gemini didn't answer ({status}).")
    }
}

/// The notes as plain text, timestamps kept: what Talk reads.
pub fn notes_document(n: &VideoNotes) -> String {
    let mut out = format!("{} ({})\n", n.title, n.kind.word());
    let line = |out: &mut String, t: &str, text: &str| {
        let t = seconds(t).map(stamp).unwrap_or_else(|| t.to_string());
        out.push_str(&format!("[{t}] {text}\n"));
    };
    if !n.question.is_empty() {
        out.push_str(&format!("Question: {}\n", n.question));
    }
    for p in &n.prerequisites {
        out.push_str(&format!("Prerequisite: {p}\n"));
    }
    for c in &n.cues {
        line(&mut out, &c.t, &format!("Cue: {}", c.text));
    }
    for c in &n.notes {
        line(&mut out, &c.t, &c.text);
    }
    for (i, s) in n.steps.iter().enumerate() {
        let mut text = format!("Step {}: {}", i + 1, s.text);
        if !s.code.is_empty() {
            text.push_str(&format!("\n{}", s.code));
        }
        if !s.gotcha.is_empty() {
            text.push_str(&format!("\nWatch out: {}", s.gotcha));
        }
        line(&mut out, &s.t, &text);
    }
    for i in &n.ideas {
        line(&mut out, &i.t, &format!("{} ({})", i.idea, i.intuition));
    }
    if !n.summary.is_empty() {
        out.push_str(&format!("Summary: {}\n", n.summary));
    }
    for s in &n.sections {
        out.push_str(&format!("Summary of {}: {}\n", s.range(), s.summary));
    }
    out
}

/// A text-only turn for Talk it through.
pub fn talk_request(system: &str, document: &str, prompt: &str) -> Value {
    json!({
        "systemInstruction": { "parts": [{ "text": system }] },
        "contents": [{ "role": "user", "parts": [{ "text": format!("{document}\n\n{prompt}") }] }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice_agent::{agent_system, turn_prompt, Source};

    const ID: &str = "dQw4w9WgXcQ";

    #[test]
    fn video_ids() {
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s",
            "https://youtu.be/dQw4w9WgXcQ?si=x",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ",
        ] {
            assert_eq!(video_id(url).as_deref(), Some(ID), "{url}");
        }
        for url in [
            "https://www.youtube.com/",
            "https://www.youtube.com/@chan",
            "https://www.youtube.com/watch?v=short",
            "https://example.com/watch?v=dQw4w9WgXcQ",
            "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
            "not a url",
        ] {
            assert_eq!(video_id(url), None, "{url}");
        }
    }

    #[test]
    fn playlist_embeds_are_not_videos_and_nocookie_is_youtube() {
        assert_eq!(
            video_id("https://www.youtube.com/embed/videoseries?list=PL123"),
            None
        );
        assert_eq!(
            video_id("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ").as_deref(),
            Some(ID)
        );
    }

    #[test]
    fn absurd_timestamps_do_not_overflow() {
        assert_eq!(seconds("4294967295:00"), None);
        assert_eq!(seconds("99999999:59:59"), None);
        assert_eq!(seconds("1193046:28:16"), None);
        assert_eq!(seconds("1193046:28:15"), Some(u32::MAX));
    }

    #[test]
    fn canonical_watch_url() {
        assert_eq!(watch_url(ID), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    }

    #[test]
    fn timestamps() {
        assert_eq!(seconds("01:15"), Some(75));
        assert_eq!(seconds("1:15"), Some(75));
        assert_eq!(seconds("1:02:03"), Some(3723));
        assert_eq!(seconds("00:00"), Some(0));
        for bad in ["7:5", "ab", "", "1:60", "1:2:3:4", "-1:00"] {
            assert_eq!(seconds(bad), None, "{bad}");
        }
        assert_eq!(stamp(75), "1:15");
        assert_eq!(stamp(5), "0:05");
        assert_eq!(stamp(3723), "1:02:03");
    }

    #[test]
    fn clip_from_the_fields() {
        let long = 25 * 3600;
        assert_eq!(clip("", "", 1000), Ok(None));
        assert_eq!(clip("", "", 0), Ok(None));
        assert!(clip("", "", long).unwrap_err().contains("set From and To"));
        assert_eq!(clip("1:00:00", "2:30:00", long), Ok(Some((3600, 9000))));
        assert_eq!(clip("", "10:00", long), Ok(Some((0, 600))));
        assert_eq!(clip("24:00:00", "", long), Ok(Some((86400, long))));
        assert_eq!(clip("5:00", "99:00:00", 1000), Ok(Some((300, 1000))));
        assert!(clip("10:00", "5:00", long).unwrap_err().contains("after"));
        assert!(clip("1:00:00", "", 0).unwrap_err().contains("To"));
        assert!(clip("abc", "", long).unwrap_err().contains("From"));
    }

    #[test]
    fn chapters_from_a_description() {
        let d = "Course notes: https://x.y\n0:00 Intro\nAttention - 1:02:03\n(12:30) Q&A\n12:30 dup\nno time here\n99:99 bad";
        assert_eq!(
            chapters(d),
            vec![
                (0, "Intro".to_string()),
                (750, "Q&A".to_string()),
                (3723, "Attention".to_string())
            ]
        );
    }

    #[test]
    fn parts_merge_then_group_in_time_order() {
        let st = |t: &str, x: &str| Stamped {
            t: t.into(),
            text: x.into(),
        };
        let sec = |from, to, summary: &str| Section {
            from,
            to,
            summary: summary.into(),
        };
        let later = VideoNotes {
            title: "T".into(),
            notes: vec![st("2:10:00", "c"), st("2:01:00", "b")],
            sections: vec![sec(7200, 9000, "two")],
            ..Default::default()
        };
        let first = VideoNotes {
            title: "other".into(),
            notes: vec![st("1:00", "a")],
            prerequisites: vec!["C".into()],
            sections: vec![sec(0, 7200, "one")],
            ..Default::default()
        };
        // Taken out of order: the later part first.
        let m = merge(later, first);
        assert_eq!(m.title, "T");
        assert_eq!(
            m.sections.iter().map(|s| s.from).collect::<Vec<_>>(),
            vec![0, 7200]
        );
        let g = group(&m);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].0.range(), "0:00–2:00:00");
        assert_eq!(g[0].1.summary, "one");
        assert_eq!(
            g[0].1
                .notes
                .iter()
                .map(|n| n.text.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
        assert_eq!(g[0].1.prerequisites, vec!["C"]);
        assert_eq!(
            g[1].1
                .notes
                .iter()
                .map(|n| n.text.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        assert!(g[1].1.prerequisites.is_empty());
        assert!(notes_document(&m).contains("Summary of 2:00:00–2:30:00: two"));
        assert!(group(&VideoNotes::default()).is_empty());
    }

    #[test]
    fn request_shape() {
        let url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
        let r = notes_request(url, None, None);
        assert_eq!(r["contents"][0]["parts"][0]["file_data"]["file_uri"], url);
        assert!(r["contents"][0]["parts"][0]["video_metadata"].is_null());
        let c = notes_request(url, None, Some((3600, 4200)));
        assert_eq!(
            c["contents"][0]["parts"][0]["video_metadata"]["start_offset"],
            "3600s"
        );
        assert_eq!(
            c["contents"][0]["parts"][0]["video_metadata"]["end_offset"],
            "4200s"
        );
        assert!(c["contents"][0]["parts"][1]["text"]
            .as_str()
            .unwrap()
            .contains("1:00:00 to 1:10:00"));
        assert!(r["contents"][0]["parts"][1]["text"]
            .as_str()
            .unwrap()
            .contains("Decide"));
        assert_eq!(
            r["generationConfig"]["responseMimeType"],
            "application/json"
        );
        let kinds = &r["generationConfig"]["responseJsonSchema"]["properties"]["kind"]["enum"];
        assert_eq!(
            kinds,
            &serde_json::json!(["lecture", "tutorial", "educational"])
        );
        let forced = notes_request(url, Some(Kind::Tutorial), None);
        let text = forced["contents"][0]["parts"][1]["text"].as_str().unwrap();
        assert!(text.contains("tutorial") && !text.contains("Decide"));
        assert!(gemini_url().ends_with("models/gemini-3.6-flash:generateContent"));
    }

    #[test]
    fn schema_makes_gemini_fill_the_shape() {
        // Live 2026-11-07: with only kind/title/summary required, Gemini put a
        // whole lecture's notes into a 9k-character title and left the lists empty.
        let r = notes_request("u", None, None);
        let sch = &r["generationConfig"]["responseJsonSchema"];
        let req: Vec<&str> = sch["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        for f in [
            "kind",
            "question",
            "prerequisites",
            "cues",
            "notes",
            "steps",
            "ideas",
            "summary",
            "title",
        ] {
            assert!(req.contains(&f), "{f} not required");
        }
        assert_eq!(sch["properties"]["title"]["maxLength"], 150);
        assert_eq!(req.first(), Some(&"kind"));
        assert_eq!(req.last(), Some(&"title"));
    }

    #[test]
    fn empty_or_overlong_notes_are_refused() {
        let body = |notes: &str| {
            format!(
                r#"{{"candidates":[{{"content":{{"parts":[{{"text":{}}}]}}}}]}}"#,
                serde_json::to_string(notes).unwrap()
            )
        };
        let lecture_empty = r#"{"kind":"lecture","title":"x","summary":"s","cues":[],"notes":[]}"#;
        assert_eq!(
            parse_notes(&body(lecture_empty), ID, "u", "T", 0).unwrap_err(),
            "Gemini's notes came back empty. Try again."
        );
        let tutorial_empty = r#"{"kind":"tutorial","title":"x","summary":"s","steps":[]}"#;
        assert!(parse_notes(&body(tutorial_empty), ID, "u", "T", 0).is_err());
        let explainer_empty = r#"{"kind":"educational","title":"x","summary":"s","ideas":[]}"#;
        assert!(parse_notes(&body(explainer_empty), ID, "u", "T", 0).is_err());
        let stuffed = format!(
            r#"{{"kind":"lecture","title":"{}","summary":"s","notes":[{{"t":"0:10","text":"n"}}]}}"#,
            "t".repeat(500)
        );
        let n = parse_notes(&body(&stuffed), ID, "u", "Tab title", 0).unwrap();
        assert_eq!(n.title, "Tab title");
    }

    const OK: &str = r#"{"candidates":[{"content":{"parts":[{"text":"{\"kind\":\"tutorial\",\"title\":\"Demo\",\"summary\":\"Set it up.\",\"prerequisites\":[\"An account\"],\"steps\":[{\"t\":\"00:28\",\"text\":\"Install it\",\"code\":\"npm i x\"}]}"}]}}],"usageMetadata":{"totalTokenCount":10}}"#;

    #[test]
    fn parsing() {
        let n = parse_notes(OK, ID, "u", "Fallback", 7).unwrap();
        assert_eq!(n.kind, Kind::Tutorial);
        assert_eq!(
            (n.id.as_str(), n.title.as_str(), n.created_at),
            (ID, "Demo", 7)
        );
        assert_eq!(n.steps[0].code, "npm i x");
        assert_eq!(n.steps[0].gotcha, "");
        let err = parse_notes(
            r#"{"error":{"code":403,"message":"Forbidden thing"}}"#,
            ID,
            "u",
            "T",
            0,
        );
        assert!(err.unwrap_err().contains("Forbidden thing"));
        let blocked = parse_notes(
            r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#,
            ID,
            "u",
            "T",
            0,
        );
        assert!(blocked.unwrap_err().starts_with("Gemini declined"));
        let junk = r#"{"candidates":[{"content":{"parts":[{"text":"not json"}]}}]}"#;
        assert_eq!(
            parse_notes(junk, ID, "u", "T", 0).unwrap_err(),
            "Gemini's notes came back unreadable."
        );
        // No title from Gemini: the tab's title stands in.
        let untitled = OK.replace(r#"\"title\":\"Demo\","#, "");
        assert_eq!(
            parse_notes(&untitled, ID, "u", "Fallback", 0)
                .unwrap()
                .title,
            "Fallback"
        );
    }

    #[test]
    fn gemini_errors_in_words() {
        let e = |s, b: &str| gemini_error(s, &format!(r#"{{"error":{{"message":"{b}"}}}}"#));
        assert_eq!(
            e(400, "API key not valid. Please pass a valid API key."),
            "The Gemini key in Settings isn't valid."
        );
        assert!(e(429, "Resource exhausted").contains("limit"));
        assert_eq!(
            e(
                400,
                "Cannot fetch content from the provided URL: video unavailable"
            ),
            "Gemini can't open this video (it may be private or unavailable)."
        );
        assert_eq!(
            e(
                400,
                "The input token count exceeds the maximum number of tokens allowed"
            ),
            "This video is too long for Gemini in one go."
        );
        assert!(gemini_error(500, "").contains("too long"));
        assert!(gemini_error(503, "").contains("503"));
    }

    #[test]
    fn talk_reads_the_notes_and_the_position() {
        let n = parse_notes(OK, ID, "u", "T", 0).unwrap();
        let doc = notes_document(&n);
        assert!(
            doc.contains("0:28")
                && doc.contains("Install it")
                && doc.contains("npm i x")
                && doc.contains("An account")
        );
        assert!(turn_prompt(&[], 75, Source::Video).starts_with("They are at 1:15 in the video."));
        let sys = agent_system("T", Source::Video);
        assert!(sys.contains("you never tell") && sys.contains("watching the video"));
        let body = talk_request("SYS", "DOC", "PROMPT");
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], "SYS");
        assert!(body["contents"][0]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("DOC"));
    }
}

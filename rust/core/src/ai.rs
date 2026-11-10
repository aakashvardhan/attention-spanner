//! Where an AI call runs, and the requests the extension makes.
//! Haiku is the only writer; the paper's own pages are the passages.

use crate::constants::{AI_CACHE_MAX_ENTRIES, CLAUDE_MODEL_QUICK};
use crate::types::AiCacheEntry;
use std::collections::HashMap;

/// For prompts whose answer renders as Markdown: math KaTeX can draw.
pub const MATH_RULE: &str = " Write any math as LaTeX: $…$ inline, $$…$$ on its own line.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Task {
    Question,
    Grade,
    Terms,
    Reframe,
    Link,
}

impl Task {
    /// The cache key prefix, as the TS wrote it.
    pub fn as_str(self) -> &'static str {
        match self {
            Task::Question => "question",
            Task::Grade => "grade",
            Task::Terms => "terms",
            Task::Reframe => "reframe",
            Task::Link => "link",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Route {
    Claude {
        model: &'static str,
        reason: &'static str,
    },
    None {
        reason: &'static str,
    },
}

/// Haiku when there is a key and a network; otherwise say what is missing.
pub fn route(online: bool, has_key: bool) -> Route {
    if !has_key {
        Route::None {
            reason: "Add a Claude API key in Settings",
        }
    } else if !online {
        Route::None {
            reason: "You are offline",
        }
    } else {
        Route::Claude {
            model: CLAUDE_MODEL_QUICK,
            reason: "Claude Haiku",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiRequest {
    pub task: Task,
    pub system: String,
    /// The grounding text (alphaXiv pages, or the passage around a word)
    pub passages: Vec<String>,
    pub prompt: String,
    /// Present = cache the answer under `task:cache_key`
    pub cache_key: Option<String>,
}

pub fn define_system() -> String {
    format!(
        "You define terminology for someone reading a research paper who is new to the field. You get \
a passage from the paper and the word the reader clicked in it. Find the term that word \
belongs to: a named method, metric, acronym or piece of jargon, or the word itself if it \
stands alone. Define it as this paper uses it, drawing on your own knowledge where the passage \
does not define it. Reply in exactly this form: **Term**: definition. The definition is one \
or two plain sentences, at most 40 words. No preamble, no emoji, no mention of the passage.{MATH_RULE}"
    )
}

/// Click-to-define: the passage around the click, keyed by the nearby phrase
/// so the same word in another phrase is defined afresh.
pub fn define_request(key: &str, word: &str, context: &str, near: &str) -> AiRequest {
    AiRequest {
        task: Task::Terms,
        system: define_system(),
        passages: vec![context.to_string()],
        prompt: format!("The reader clicked \"{word}\". Define the term it belongs to."),
        cache_key: Some(format!("{key}:{near}")),
    }
}

/// The `aiCache` storage key: `task:cacheKey` → the answer.
pub type AiCache = HashMap<String, AiCacheEntry>;

/// A saved answer; one from a model target that no longer exists is a miss.
pub fn cache_hit<'a>(cache: &'a AiCache, key: &str) -> Option<&'a AiCacheEntry> {
    cache.get(key).filter(|e| e.target == "claude")
}

/// Save an answer, dropping the oldest past the cap.
pub fn cache_put(cache: &mut AiCache, key: String, entry: AiCacheEntry) {
    cache.insert(key, entry);
    while cache.len() > AI_CACHE_MAX_ENTRIES {
        let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, e)| e.at)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        cache.remove(&oldest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_uses_haiku_with_a_key_and_a_network() {
        assert_eq!(
            route(true, true),
            Route::Claude {
                model: CLAUDE_MODEL_QUICK,
                reason: "Claude Haiku"
            }
        );
        assert_eq!(
            route(false, false),
            Route::None {
                reason: "Add a Claude API key in Settings"
            }
        );
        assert_eq!(
            route(false, true),
            Route::None {
                reason: "You are offline"
            }
        );
    }

    #[test]
    fn define_sends_the_passage_and_names_the_word() {
        let r = define_request("doc", "TD", "We use TD learning here.", "use TD learning");
        assert_eq!(r.task, Task::Terms);
        assert_eq!(r.passages, ["We use TD learning here."]);
        assert!(r.prompt.contains("\"TD\""));
        assert!(r.system.ends_with(MATH_RULE));
    }

    #[test]
    fn define_caches_per_phrase() {
        let a = define_request("doc", "TD", "c", "use TD learning");
        let b = define_request("doc", "TD", "c", "the TD error");
        assert_ne!(a.cache_key, b.cache_key);
    }

    fn entry(at: i64, target: &str) -> AiCacheEntry {
        AiCacheEntry {
            text: format!("t{at}"),
            target: target.into(),
            model: "m".into(),
            at,
        }
    }

    #[test]
    fn the_cache_keeps_the_newest_and_ignores_retired_targets() {
        let mut cache = AiCache::new();
        for at in 0..AI_CACHE_MAX_ENTRIES as i64 + 3 {
            cache_put(&mut cache, format!("k{at}"), entry(at, "claude"));
        }
        assert_eq!(cache.len(), AI_CACHE_MAX_ENTRIES);
        assert!(cache_hit(&cache, "k0").is_none());
        assert!(cache_hit(&cache, "k3").is_some());
        cache.insert("old".into(), entry(999, "retired-model"));
        assert!(cache_hit(&cache, "old").is_none());
    }
}

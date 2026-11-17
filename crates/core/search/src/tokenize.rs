//! Dictionary-free tokenizing: Latin runs are lowercased words, CJK runs
//! adjacent character bigrams, a lone CJK character a token of its own.
//!
//! `tokenize` is the QUERY side and deliberately narrower than
//! `tokenize_for_index`, which also emits every CJK character on its own: a
//! two-character query means the pair, but a one-character query must still
//! find a name that is a single CJK run.

use crate::fold::fold_for_search;
use crate::unicode::is_word;

fn is_cjk(c: char) -> bool {
    matches!(u32::from(c), 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff)
}

#[must_use]
pub fn tokenize(text: &str) -> Vec<String> {
    collect(text, false)
}

#[must_use]
pub fn tokenize_for_index(text: &str) -> Vec<String> {
    collect(text, true)
}

fn collect(text: &str, unigrams: bool) -> Vec<String> {
    let mut tokens = Vec::new();
    tokenize_runs(text, unigrams, &mut |token| {
        tokens.push(token.to_owned());
        true
    });
    tokens
}

/// Feeds each token to `emit` in text order, stopping as soon as `emit`
/// answers false; answers false itself when it was stopped.
pub fn tokenize_runs(text: &str, unigrams: bool, emit: &mut impl FnMut(&str) -> bool) -> bool {
    let folded = fold_for_search(text);
    for run in folded.split(|c| !is_word(c)).filter(|run| !run.is_empty()) {
        for (stretch, cjk) in script_stretches(run) {
            if !emit_stretch(stretch, cjk, unigrams, emit) {
                return false;
            }
        }
    }
    true
}

/// A run split into its CJK and non-CJK stretches: "bm25で検索" arrives as one
/// letter-or-number run, and word-tokenizing it whole would glue the scripts
/// together into a token nobody types.
fn script_stretches(run: &str) -> Vec<(&str, bool)> {
    let mut stretches = Vec::new();
    let mut from = 0_usize;
    let mut cjk = false;
    for (at, c) in run.char_indices() {
        let this = is_cjk(c);
        if at > from && this != cjk {
            if let Some(stretch) = run.get(from..at) {
                stretches.push((stretch, cjk));
            }
            from = at;
        }
        cjk = this;
    }
    if let Some(stretch) = run.get(from..) {
        stretches.push((stretch, cjk));
    }
    stretches
}

fn emit_stretch(
    text: &str,
    cjk: bool,
    unigrams: bool,
    emit: &mut impl FnMut(&str) -> bool,
) -> bool {
    if !cjk {
        return emit(text);
    }
    // A CJK character is one UTF-16 unit, so a stretch's length is its count.
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    if unigrams || chars.len() == 1 {
        for (at, c) in &chars {
            if !emit(text.get(*at..at.saturating_add(c.len_utf8())).unwrap_or_default()) {
                return false;
            }
        }
    }
    for pair in chars.windows(2) {
        let (Some((from, _)), Some((last, c))) = (pair.first(), pair.last()) else { continue };
        let end = last.saturating_add(c.len_utf8());
        if !emit(text.get(*from..end).unwrap_or_default()) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn words(tokens: &[&str]) -> Vec<String> {
        tokens.iter().map(|t| (*t).to_owned()).collect()
    }

    #[test]
    fn cjk_runs_become_bigrams_and_latin_runs_words() {
        assert_eq!(tokenize("検索基盤"), words(&["検索", "索基", "基盤"]));
        assert_eq!(tokenize("Full-Text SEARCH"), words(&["full", "text", "search"]));
        assert_eq!(tokenize("BM25で検索"), words(&["bm25", "で検", "検索"]));
        assert_eq!(tokenize("図"), words(&["図"]));
        assert_eq!(tokenize("  ,, 。 a "), words(&["a"]));
    }

    #[test]
    fn the_index_side_adds_every_cjk_character() {
        assert_eq!(tokenize_for_index("かが"), words(&["か", "が", "かが"]));
        assert_eq!(tokenize("がっこう"), words(&["がっ", "っこ", "こう"]));
        assert_eq!(tokenize("café"), words(&["cafe"]));
    }

    #[test]
    fn a_refusing_emitter_stops_the_walk() {
        let mut seen = 0;
        let finished = tokenize_runs("a b c", false, &mut |_| {
            seen += 1;
            seen < 2
        });
        assert!(!finished);
        assert_eq!(seen, 2);
        let mut cjk_seen = 0;
        assert!(!tokenize_runs("検索", true, &mut |_| {
            cjk_seen += 1;
            false
        }));
        assert_eq!(cjk_seen, 1);
        assert!(!tokenize_runs("検索", false, &mut |_| false));
    }
}

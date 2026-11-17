//! What search compares: text lowercased and, for Latin script, with its
//! diacritics folded away, so "cafe" finds "Café".
//!
//! Folding is per code point, which is what lets a match in the folded text
//! be mapped back onto the ORIGINAL. Only marks that sit on a Latin letter
//! are dropped: a dakuten is a combining mark under NFKD too, and stripping
//! it would make が and か one character. A compatibility form whose
//! decomposition is Latin or ASCII folds to that decomposition.

use crate::unicode::{is_latin, is_mark, lowercase, nfkd, push_lowercase};

/// A folded text with where each of its code points came from, in UTF-16 code
/// units of the original.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folded {
    pub text: String,
    /// Where the source of the folded code point `i` starts.
    pub starts: Vec<usize>,
    /// Where that source ends, any marks folded into it included.
    pub ends: Vec<usize>,
}

/// A span of the original text, in UTF-16 code units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Found {
    pub index: usize,
    pub length: usize,
}

/// Kana, CJK ideographs and Hangul syllables have no case and no Latin
/// decomposition, so each folds to itself without asking a table.
const fn folds_to_itself(unit: u32) -> bool {
    matches!(unit, 0x3040..=0x30ff | 0x3400..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff)
}

/// What one code point folds to, and whether it ends a Latin letter, which is
/// what lets a mark after it be folded into it.
#[must_use]
pub fn fold_code_point(c: char) -> (String, bool) {
    if c.is_ascii() {
        return (c.to_ascii_lowercase().to_string(), c.is_ascii_alphabetic());
    }
    if folds_to_itself(u32::from(c)) {
        return (c.to_string(), false);
    }
    let mut lower = String::new();
    push_lowercase(c, &mut lower);
    let decomposed = lowercase(&nfkd(&lower));
    let first_is_latin = decomposed.chars().next().is_some_and(is_latin);
    let ascii = !decomposed.is_empty() && decomposed.chars().all(|d| matches!(d, ' '..='~'));
    if first_is_latin || ascii {
        let out: String = decomposed.chars().filter(|d| !is_mark(*d)).collect();
        let latin = out.chars().next_back().is_some_and(is_latin);
        return (out, latin);
    }
    (lower, false)
}

/// The folded text, with where each of its code points came from.
#[must_use]
pub fn fold_with_offsets(text: &str) -> Folded {
    let mut folded = Folded { text: String::new(), starts: Vec::new(), ends: Vec::new() };
    let mut after_latin = false;
    let mut offset = 0_usize;
    for c in text.chars() {
        let end = offset.saturating_add(c.len_utf16());
        if after_latin && is_mark(c) {
            // The mark belongs to the letter before it: a match ending on that
            // letter ends after its accent, not between the two.
            if let Some(last) = folded.ends.last_mut() {
                *last = end;
            }
        } else {
            let (out, latin) = fold_code_point(c);
            for each in out.chars() {
                folded.starts.push(offset);
                folded.ends.push(end);
                folded.text.push(each);
            }
            after_latin = latin;
        }
        offset = end;
    }
    folded
}

#[must_use]
pub fn fold_for_search(text: &str) -> String {
    fold_with_offsets(text).text
}

/// Where `needle` occurs in `text` once both are folded, as a span of the
/// ORIGINAL `text`; none when it does not, or folds to nothing.
#[must_use]
pub fn find_folded(text: &str, needle: &str) -> Option<Found> {
    let wanted = fold_for_search(needle);
    if wanted.is_empty() {
        return None;
    }
    span_of(&fold_with_offsets(text), &wanted)
}

/// `wanted` (already folded) in `folded`, mapped back to an original span.
#[must_use]
pub fn span_of(folded: &Folded, wanted: &str) -> Option<Found> {
    if wanted.is_empty() {
        return None;
    }
    let at = folded.text.find(wanted)?;
    let first = folded.text.get(..at)?.chars().count();
    let last = first.saturating_add(wanted.chars().count()).saturating_sub(1);
    let index = *folded.starts.get(first)?;
    let end = *folded.ends.get(last)?;
    Some(Found { index, length: end.saturating_sub(index) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn latin_diacritics_fold_away_and_other_scripts_stay() {
        assert_eq!(fold_for_search("Café"), "cafe");
        assert_eq!(fold_for_search("Cafe\u{301}"), "cafe");
        assert_eq!(fold_for_search("がっこう"), "がっこう");
        assert_eq!(fold_for_search("か\u{3099}"), "か\u{3099}");
        assert_eq!(fold_for_search("й"), "й");
        assert_eq!(fold_for_search("ﬃ ① Ａ"), "ffi 1 a");
        assert_eq!(fold_for_search("İ"), "i");
    }

    #[test]
    fn a_match_maps_back_onto_the_original_with_its_accent() {
        assert_eq!(
            find_folded("Order from the Café du Monde", "cafe"),
            Some(Found { index: 15, length: 4 })
        );
        assert_eq!(
            find_folded("cafe\u{301} noir", "cafe\u{301}"),
            Some(Found { index: 0, length: 5 })
        );
        assert_eq!(find_folded("Bakery", "cafe"), None);
        assert_eq!(find_folded("abc", ""), None);
        assert_eq!(find_folded("x😀y", "y"), Some(Found { index: 3, length: 1 }));
    }

    #[test]
    fn a_mark_alone_or_after_a_non_latin_letter_is_kept() {
        assert_eq!(fold_for_search("\u{301}x"), "\u{301}x");
        assert_eq!(fold_for_search("е\u{308}"), "е\u{308}");
    }

    #[test]
    fn the_scripts_that_skip_the_table_fold_to_themselves_all_the_same() {
        for range in [0x3040..=0x30ff_u32, 0x3400..=0x9fff, 0xac00..=0xd7af, 0xf900..=0xfaff] {
            for c in range.filter_map(char::from_u32) {
                assert_eq!(fold_code_point(c), (c.to_string(), false), "U+{:04X}", u32::from(c));
            }
        }
    }
}

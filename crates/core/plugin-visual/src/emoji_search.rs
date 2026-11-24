//! What a document is FINDABLE by when it shows an emoji rather than naming
//! it (`emojiSearchText`): the names of every emoji a text shows or writes as
//! a shortcode, lent to a search index as text.
//!
//! The terms per character are generated beside the catalog the TypeScript
//! reads (`emoji-search-terms.tsv`), and so is its gate: the code points the
//! TypeScript's runtime reads as `Extended_Pictographic`
//! (`extended-pictographic.txt`). The gate is that set and not "a grapheme
//! the table names", because a keycap and a flag are catalog rows outside it:
//! shown alone they lend nothing, beside a pictograph they lend their row.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use unicode_segmentation::UnicodeSegmentation;

use crate::shortcode::emoji_shortcode_chars;

/// `character<TAB>terms`, one row per catalog character in catalog order.
const TERMS: &str =
    include_str!("../../../../packages/plugin-visual/src/emoji/emoji-search-terms.tsv");

/// `first..last` in hex, the `Extended_Pictographic` ranges, ascending.
const PICTOGRAPHIC: &str =
    include_str!("../../../../packages/plugin-visual/src/emoji/extended-pictographic.txt");

/// The terms each character is found by; a later row of a character replaces
/// an earlier one, as the TypeScript's map does.
fn terms_with(table: &str) -> BTreeMap<&str, &str> {
    table.lines().filter_map(|row| row.split_once('\t')).collect()
}

fn terms() -> &'static BTreeMap<&'static str, &'static str> {
    static TABLE: OnceLock<BTreeMap<&'static str, &'static str>> = OnceLock::new();
    TABLE.get_or_init(|| terms_with(TERMS))
}

fn ranges_with(listed: &str) -> Vec<(u32, u32)> {
    let code = |hex: &str| u32::from_str_radix(hex, 16).ok();
    listed
        .lines()
        .filter_map(|row| {
            let (first, last) = row.split_once("..")?;
            Some((code(first)?, code(last)?))
        })
        .collect()
}

fn pictographic_ranges() -> &'static [(u32, u32)] {
    static RANGES: OnceLock<Vec<(u32, u32)>> = OnceLock::new();
    RANGES.get_or_init(|| ranges_with(PICTOGRAPHIC))
}

fn is_pictographic(ranges: &[(u32, u32)], c: char) -> bool {
    let code = u32::from(c);
    let after = ranges.partition_point(|(first, _)| *first <= code);
    after.checked_sub(1).and_then(|at| ranges.get(at)).is_some_and(|(_, last)| code <= *last)
}

/// `emojiSearchText`: the terms of every emoji `text` shows (matched as
/// graphemes, so a flag or a joined family is one thing) and of every
/// shortcode it writes, each row once, in the order first met; `""` for a
/// text with neither a pictograph nor a colon.
#[must_use]
pub fn emoji_search_text(text: &str) -> String {
    let pictographic = text.chars().any(|c| is_pictographic(pictographic_ranges(), c));
    if !pictographic && !text.contains(':') {
        return String::new();
    }
    let table = terms();
    let mut found: Vec<&str> = Vec::new();
    let mut lend = |shown: &str| {
        if let Some(row) = table.get(shown).copied()
            && !found.contains(&row)
        {
            found.push(row);
        }
    };
    if pictographic {
        text.graphemes(true).for_each(&mut lend);
    }
    emoji_shortcode_chars(text).into_iter().for_each(&mut lend);
    found.join(" ")
}

#[cfg(test)]
mod tests {
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::*;

    #[test]
    fn a_later_row_of_a_character_replaces_an_earlier_one() {
        let table = terms_with("a\tfirst\nno tab\nb\tbee\na\tsecond\n");
        assert_eq!(table.get("a"), Some(&"second"));
        assert_eq!(table.len(), 2);
    }

    #[test]
    fn a_code_point_is_pictographic_inside_a_range_and_at_both_ends() {
        let ranges = ranges_with("00A9..00A9\n2194..2199\nnot a range\n1F000..1F0FF\n");
        assert_eq!(ranges.len(), 3);
        let at = |code: u32| is_pictographic(&ranges, char::from_u32(code).expect("a char"));
        assert!(at(0xA9) && at(0x2194) && at(0x2196) && at(0x2199) && at(0x1F0FF));
        assert!(!at(0xA8) && !at(0xAA) && !at(0x2193) && !at(0x219A) && !at(0x41));
    }

    #[test]
    fn each_row_is_lent_once_in_the_order_first_met() {
        let rocket = emoji_search_text("🚀");
        let fire = emoji_search_text(":fire:");
        assert!(!rocket.is_empty() && !fire.is_empty());
        assert_eq!(emoji_search_text("🚀 :fire: 🚀 :rocket:"), format!("{rocket} {fire}"));
        assert_eq!(emoji_search_text("plain words"), "");
    }
}

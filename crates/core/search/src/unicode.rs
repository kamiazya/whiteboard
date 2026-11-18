//! The Unicode properties search reads, as the data `crates/core/search/src/tables.rs` holds.
//!
//! std's tables follow the toolchain (`char::UNICODE_VERSION`), so none is
//! used (QR-20b). The tables are generated from pinned crates, whose releases
//! differ from the TypeScript oracle's runtime; where an answer differs for a
//! code point, `crates/core/search/tests/unicode_table_diff.json` ledgers it, and
//! `crates/core/search/tests/unicode_tables.rs` holds the data to the crates code point by code
//! point.

use crate::tables::{
    FOLD_KEYS, FOLD_POOL, FOLD_VALUES, LATIN, MARK_BOUNDARIES, MULTI, WORD_BOUNDARIES,
};

/// Whether `c` lies in the set whose edges are `boundaries`: inside once an odd
/// number of them are at or below it.
fn within(boundaries: &[u32], c: char) -> bool {
    boundaries.partition_point(|&edge| edge <= u32::from(c)) & 1 == 1
}

/// `/\p{M}/u`: a mark (`Mn`, `Mc` or `Me`).
#[must_use]
pub fn is_mark(c: char) -> bool {
    within(&MARK_BOUNDARIES, c)
}

/// `/[\p{L}\p{N}]/u`: a letter or a number, what a word is made of.
#[must_use]
pub fn is_word(c: char) -> bool {
    within(&WORD_BOUNDARIES, c)
}

/// What a non-ASCII code point folds to and whether the fold ends a Latin
/// letter, when it is anything but itself; none otherwise.
pub(crate) fn fold_of(c: char) -> Option<(String, bool)> {
    let at = FOLD_KEYS.binary_search(&u32::from(c)).ok()?;
    let value = *FOLD_VALUES.get(at)?;
    let folded = if value & MULTI == 0 {
        char::from_u32(value & 0x001f_ffff)?.to_string()
    } else {
        let offset = usize::try_from(value & 0xffff).ok()?;
        let len = usize::try_from((value >> 16) & 0xff).ok()?;
        FOLD_POOL.get(offset..offset.saturating_add(len))?.to_owned()
    };
    Some((folded, value & LATIN != 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn classes_follow_the_properties() {
        assert!(is_mark('\u{301}'));
        assert!(!is_mark('a'));
        assert!(is_word('a') && is_word('検') && is_word('٣') && is_word('²'));
        assert!(!is_word('-') && !is_word('🚀'));
    }

    #[test]
    fn a_fold_is_one_code_point_or_a_run_of_the_pool() {
        assert_eq!(fold_of('Σ'), Some(("σ".to_owned(), false)));
        assert_eq!(fold_of('É'), Some(("e".to_owned(), true)));
        assert_eq!(fold_of('é'), Some(("e".to_owned(), true)));
        assert_eq!(fold_of('ﬃ'), Some(("ffi".to_owned(), true)));
        assert_eq!(fold_of('İ'), Some(("i".to_owned(), true)));
        assert_eq!(fold_of('я'), None);
    }
}

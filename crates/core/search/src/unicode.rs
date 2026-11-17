//! The Unicode properties search reads, each from a pinned crate.
//!
//! std's tables follow the toolchain (`char::UNICODE_VERSION`), so none is
//! used (QR-20b). The crates carry different Unicode releases, and the
//! TypeScript oracle carries its runtime's; where an answer differs for a code
//! point, `tests/unicode_table_diff.json` ledgers it.

use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};
use unicode_script::{Script, UnicodeScript};

/// The Unicode release of each table, as its crate reports it.
#[must_use]
pub fn table_versions() -> [(&'static str, (u64, u64, u64)); 4] {
    [
        ("unicode-case-mapping", unicode_case_mapping::UNICODE_VERSION),
        ("unicode-normalization", widen(unicode_normalization::UNICODE_VERSION)),
        ("unicode-properties", unicode_properties::UNICODE_VERSION),
        ("unicode-script", unicode_script::UNICODE_VERSION),
    ]
}

const fn widen((major, minor, patch): (u8, u8, u8)) -> (u64, u64, u64) {
    (major as u64, minor as u64, patch as u64)
}

/// `/\p{M}/u`: a mark (`Mn`, `Mc` or `Me`).
#[must_use]
pub fn is_mark(c: char) -> bool {
    c.general_category_group() == GeneralCategoryGroup::Mark
}

/// `/[\p{L}\p{N}]/u`: a letter or a number, what a word is made of.
#[must_use]
pub fn is_word(c: char) -> bool {
    matches!(
        c.general_category_group(),
        GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
    )
}

/// `/\p{Script=Latin}/u`: the Script property, not `Script_Extensions`.
#[must_use]
pub fn is_latin(c: char) -> bool {
    c.script() == Script::Latin
}

/// `String#toLowerCase` of one code point, appended to `out`: its full
/// (special-casing included) lowercase mapping, which is at most two code
/// points. The context rule for a final sigma needs a neighbour, and one code
/// point has none.
pub fn push_lowercase(c: char, out: &mut String) {
    let [first, second] = unicode_case_mapping::to_lowercase(c);
    if first == 0 {
        out.push(c);
        return;
    }
    out.extend(char::from_u32(first));
    if second != 0 {
        out.extend(char::from_u32(second));
    }
}

/// Every code point's lowercase mapping through `String#toLowerCase`'s
/// one-point reading.
#[must_use]
pub fn lowercase(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        push_lowercase(c, &mut out);
    }
    out
}

/// NFKD of `text`.
#[must_use]
pub fn nfkd(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfkd().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn each_table_reports_the_release_it_was_pinned_at() {
        assert_eq!(
            table_versions(),
            [
                ("unicode-case-mapping", (16, 0, 0)),
                ("unicode-normalization", (18, 0, 0)),
                ("unicode-properties", (18, 0, 0)),
                ("unicode-script", (18, 0, 0)),
            ]
        );
    }

    #[test]
    fn a_dotted_capital_i_lowercases_to_two_code_points() {
        assert_eq!(lowercase("İ"), "i\u{307}");
        assert_eq!(lowercase("ß"), "ß");
        assert_eq!(lowercase("Σ"), "σ");
        assert_eq!(lowercase("a"), "a");
    }

    #[test]
    fn classes_follow_the_properties() {
        assert!(is_mark('\u{301}'));
        assert!(!is_mark('a'));
        assert!(is_word('a') && is_word('検') && is_word('٣') && is_word('²'));
        assert!(!is_word('-') && !is_word('🚀'));
        assert!(is_latin('é') && !is_latin('й') && !is_latin('\u{301}'));
    }

    #[test]
    fn nfkd_decomposes_compatibility_forms() {
        assert_eq!(nfkd("ﬃ①é"), "ffi1e\u{301}");
    }
}

//! The generated Unicode tables against the pinned crates they were generated
//! from.
//!
//! `src/tables.rs` holds what search asks of Unicode (what a code point folds
//! to, whether it is a mark, a letter or a number) as data, so the four crates
//! that answer it stay out of the shipped module. They are dev-dependencies
//! here: this file is the generator, the equality check between the committed
//! file and a regeneration, the exhaustive per-code-point comparison with the
//! crates (which is also what holds the Unicode release), and the comparison
//! over random strings, where folding meets its context (a mark after a
//! letter).
//!
//! Regenerate with `UPDATE_UNICODE_TABLES=1 cargo test -p whiteboard-search
//! --test unicode_tables`.

use std::collections::BTreeMap;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};
use unicode_script::{Script, UnicodeScript};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_proptest::proptest::prelude::{Strategy, any, prop, prop_assert_eq, prop_oneof};
use whiteboard_proptest::{Floor, check};
use whiteboard_search::fold::{fold_code_point, fold_with_offsets};
use whiteboard_search::unicode::{is_mark, is_word};

const COMMITTED: &str = include_str!("../src/tables.rs");

/// What each crate path answered before the tables replaced it: the reference
/// every comparison below holds the tables to.
mod reference {
    use super::*;
    use unicode_normalization::UnicodeNormalization;

    pub(super) fn is_mark(c: char) -> bool {
        c.general_category_group() == GeneralCategoryGroup::Mark
    }

    pub(super) fn is_word(c: char) -> bool {
        matches!(
            c.general_category_group(),
            GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
        )
    }

    fn is_latin(c: char) -> bool {
        c.script() == Script::Latin
    }

    fn push_lowercase(c: char, out: &mut String) {
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

    fn lowercase(text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        for c in text.chars() {
            push_lowercase(c, &mut out);
        }
        out
    }

    const fn folds_to_itself(unit: u32) -> bool {
        matches!(unit, 0x3040..=0x30ff | 0x3400..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff)
    }

    pub(super) fn fold_code_point(c: char) -> (String, bool) {
        if c.is_ascii() {
            return (c.to_ascii_lowercase().to_string(), c.is_ascii_alphabetic());
        }
        if folds_to_itself(u32::from(c)) {
            return (c.to_string(), false);
        }
        let mut lower = String::new();
        push_lowercase(c, &mut lower);
        let decomposed = lowercase(&lower.nfkd().collect::<String>());
        let first_is_latin = decomposed.chars().next().is_some_and(is_latin);
        let ascii = !decomposed.is_empty() && decomposed.chars().all(|d| matches!(d, ' '..='~'));
        if first_is_latin || ascii {
            let out: String = decomposed.chars().filter(|d| !is_mark(*d)).collect();
            let latin = out.chars().next_back().is_some_and(is_latin);
            return (out, latin);
        }
        (lower, false)
    }

    pub(super) fn fold_text(text: &str) -> (String, Vec<usize>, Vec<usize>) {
        let (mut out, mut starts, mut ends) = (String::new(), Vec::new(), Vec::new());
        let (mut after_latin, mut offset) = (false, 0_usize);
        for c in text.chars() {
            let end = offset + c.len_utf16();
            if after_latin && is_mark(c) {
                if let Some(last) = ends.last_mut() {
                    *last = end;
                }
            } else {
                let (folded, latin) = fold_code_point(c);
                for each in folded.chars() {
                    starts.push(offset);
                    ends.push(end);
                    out.push(each);
                }
                after_latin = latin;
            }
            offset = end;
        }
        (out, starts, ends)
    }
}

/// The generator: not tests, so the core lints on `expect` apply to it unless
/// it sits in test code.
#[cfg(test)]
mod generate {
    use super::*;
    use std::fmt::Write as _;

    pub(super) fn scalars() -> impl Iterator<Item = char> {
        (0..=0x0010_ffff_u32).filter_map(char::from_u32)
    }

    /// The code points where `member` flips, as the table's boundaries: a code
    /// point is in the set when an odd number of boundaries are at or below it.
    /// The surrogates are no `char` and carry the run they sit in.
    fn boundaries(member: impl Fn(char) -> bool) -> Vec<u32> {
        let mut out = Vec::new();
        let mut inside = false;
        for cp in 0..=0x0010_ffff_u32 {
            let now = char::from_u32(cp).map_or(inside, &member);
            if now != inside {
                out.push(cp);
                inside = now;
            }
        }
        out
    }

    const LATIN: u32 = 1 << 31;
    const MULTI: u32 = 1 << 30;

    fn fold_rows() -> (Vec<(u32, u32)>, String) {
        let mut pool = String::new();
        let mut seen: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        let mut rows = Vec::new();
        for c in scalars().filter(|c| !c.is_ascii()) {
            let (folded, latin) = reference::fold_code_point(c);
            if !latin && folded == c.to_string() {
                continue;
            }
            let flag = if latin { LATIN } else { 0 };
            let mut chars = folded.chars();
            let value = if let (Some(only), None) = (chars.next(), chars.next()) {
                u32::from(only)
            } else {
                {
                    assert!(!folded.is_empty(), "{c:?} folds to nothing");
                    let (offset, len) = *seen.entry(folded.clone()).or_insert_with(|| {
                        let at = pool.len();
                        pool.push_str(&folded);
                        (at, folded.len())
                    });
                    assert!(offset <= 0xffff && len <= 0xff, "{c:?}: outside the packing");
                    MULTI
                        | (u32::try_from(len).expect("len") << 16)
                        | u32::try_from(offset).expect("offset")
                }
            };
            rows.push((u32::from(c), flag | value));
        }
        (rows, pool)
    }

    fn hex_rows(label: &str, ty: &str, values: &[u32]) -> String {
        let mut out =
            format!("#[rustfmt::skip]\npub(crate) static {label}: [{ty}; {}] = [\n", values.len());
        for line in values.chunks(8) {
            let cells: Vec<String> =
                line.iter().map(|v| format!("0x{:04x}_{:04x},", v >> 16, v & 0xffff)).collect();
            let _ = writeln!(out, "    {}", cells.join(" "));
        }
        out.push_str("];\n");
        out
    }

    pub(super) fn render() -> String {
        let (rows, pool) = fold_rows();
        let keys: Vec<u32> = rows.iter().map(|row| row.0).collect();
        let values: Vec<u32> = rows.iter().map(|row| row.1).collect();
        let mut out = String::from(
            "// Generated by `tests/unicode_tables.rs` from the pinned unicode-case-mapping,\n\
             // unicode-normalization, unicode-properties and unicode-script crates; do not edit.\n\
             // `UPDATE_UNICODE_TABLES=1 cargo test -p whiteboard-search --test unicode_tables`\n\
             // regenerates it, and the test fails when this file is not what that writes.\n\n\
             //! What search asks of Unicode, as data.\n\n",
        );
        out.push_str(
            "/// Set when the folded text ends in a Latin letter, so a mark after it folds into it.\n\
             pub(crate) const LATIN: u32 = 1 << 31;\n\
             /// Set when the fold is more than one code point: `pool` bytes at the low 16 bits,\n\
             /// as many as bits 16..24 say. Unset, the low 21 bits are the one code point.\n\
             pub(crate) const MULTI: u32 = 1 << 30;\n\n",
        );
        out.push_str(
            "/// The non-ASCII code points that fold to anything but themselves, ascending.\n",
        );
        out.push_str(&hex_rows("FOLD_KEYS", "u32", &keys));
        out.push_str("\n/// What each of `FOLD_KEYS` folds to.\n");
        out.push_str(&hex_rows("FOLD_VALUES", "u32", &values));
        let _ = write!(
            out,
            "\n/// The folds of more than one code point.\npub(crate) static FOLD_POOL: &str = {pool:?};\n"
        );
        out.push_str("\n/// Where `/\\p{M}/u` flips, ascending.\n");
        out.push_str(&hex_rows("MARK_BOUNDARIES", "u32", &boundaries(reference::is_mark)));
        out.push_str("\n/// Where `/[\\p{L}\\p{N}]/u` flips, ascending.\n");
        out.push_str(&hex_rows("WORD_BOUNDARIES", "u32", &boundaries(reference::is_word)));
        out
    }

    pub(super) fn releases() -> impl Iterator<Item = (u64, u64, u64)> {
        let widen = |(a, b, c): (u8, u8, u8)| (u64::from(a), u64::from(b), u64::from(c));
        [
            unicode_case_mapping::UNICODE_VERSION,
            widen(unicode_normalization::UNICODE_VERSION),
            unicode_properties::UNICODE_VERSION,
            unicode_script::UNICODE_VERSION,
        ]
        .into_iter()
    }

    /// Writes the regenerated file where it is committed.
    #[expect(
        clippy::disallowed_methods,
        reason = "the generator's one write, a developer's command"
    )]
    pub(super) fn update(generated: &str) -> bool {
        if std::env::var_os("UPDATE_UNICODE_TABLES").is_none() {
            return false;
        }
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/tables.rs");
        std::fs::write(path, generated).expect("write the tables");
        true
    }
}
use generate::{releases, render, scalars};

#[test]
fn the_committed_tables_are_what_the_generator_writes() {
    let generated = render();
    #[cfg(not(target_arch = "wasm32"))]
    if generate::update(&generated) {
        return;
    }
    assert!(
        generated == COMMITTED,
        "src/tables.rs is not what the generator writes; regenerate it with UPDATE_UNICODE_TABLES=1"
    );
}

#[test]
fn the_tables_were_generated_from_the_pinned_releases() {
    assert_eq!(releases().collect::<Vec<_>>(), [(16, 0, 0), (18, 0, 0), (18, 0, 0), (18, 0, 0)]);
}

#[test]
fn every_code_point_answers_what_the_crates_answer() {
    let mut folded_away = 0_u32;
    for c in scalars() {
        assert_eq!(
            fold_code_point(c),
            reference::fold_code_point(c),
            "fold of U+{:04X}",
            u32::from(c)
        );
        assert_eq!(is_mark(c), reference::is_mark(c), "mark U+{:04X}", u32::from(c));
        assert_eq!(is_word(c), reference::is_word(c), "word U+{:04X}", u32::from(c));
        folded_away += u32::from(fold_code_point(c).0 != c.to_string());
    }
    // The table is present: Latin Extended and the compatibility forms fold.
    assert!(folded_away > 3000, "{folded_away} code points fold to something else");
}

#[test]
fn a_mark_folds_into_the_letter_before_it_and_a_context_free_fold_stays_per_code_point() {
    for text in [
        "Σ",
        "ΑΣ",
        "ΑΣ ",
        "İ",
        "i\u{307}",
        "\u{1e9b}\u{323}",
        "\u{1e69}",
        "s\u{323}\u{307}",
        "ǭ",
        "ﬃ\u{301}",
        "①\u{301}",
        "が",
        "か\u{3099}",
        "e\u{301}\u{301}",
        "\u{301}e",
        "я\u{301}",
        "ｆｕｌｌ",
    ] {
        let folded = fold_with_offsets(text);
        assert_eq!(
            (folded.text, folded.starts, folded.ends),
            reference::fold_text(text),
            "{text:?}"
        );
    }
    assert_eq!(fold_with_offsets("ΑΣ").text, "ασ");
    assert_eq!(fold_with_offsets("\u{1e69}").text, "s");
    assert_eq!(fold_with_offsets("が").text, "が");
    assert_eq!(fold_with_offsets("ǭ\u{301}").ends, [2]);
}

static FOLDING: Floor = Floor::new("a string with a code point the fold changes");

#[test]
fn folding_random_strings_matches_the_crates() {
    // Letters, accented forms, compatibility forms, marks and ill-assorted
    // scripts, weighted well above their share of random text.
    let piece = prop_oneof![
        any::<char>().prop_map(String::from),
        prop::sample::select(vec![
            "e",
            "E",
            "é",
            "É",
            "\u{301}",
            "\u{323}",
            "\u{307}",
            "ǭ",
            "ṩ",
            "ẛ",
            "ﬃ",
            "①",
            "Σ",
            "ς",
            "İ",
            "ß",
            "я",
            "が",
            "\u{3099}",
            "한",
            "ｆ",
            "Ａ",
            "™",
            " ",
            "-",
            "\u{1f600}",
            "ª",
            "µ",
        ])
        .prop_map(str::to_owned),
    ];
    check(prop::collection::vec(piece, 0..24).prop_map(|parts| parts.concat()), None, |text| {
        let changed = text.chars().any(|c| fold_code_point(c) != (c.to_string(), false));
        FOLDING.draw(changed);
        let folded = fold_with_offsets(&text);
        prop_assert_eq!((folded.text, folded.starts, folded.ends), reference::fold_text(&text));
        Ok(())
    });
    FOLDING.assert(100);
}

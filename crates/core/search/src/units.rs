//! UTF-16 code units, the strings JavaScript indexes: an excerpt is cut by
//! unit, and a cut may fall where a `&str` has no boundary.

use whiteboard_det::utf16::is_js_whitespace;

pub(crate) const LF: u16 = 0x0a;
pub(crate) const CR: u16 = 0x0d;
pub(crate) const LS: u16 = 0x2028;
pub(crate) const PS: u16 = 0x2029;

#[must_use]
pub(crate) fn encode(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// A string back from units; an unpaired surrogate, which a `String` cannot
/// hold, reads as U+FFFD.
#[must_use]
pub(crate) fn decode(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `slice(from, to)` for non-negative arguments: clamped, empty when reversed.
#[must_use]
pub(crate) fn slice(units: &[u16], from: usize, to: usize) -> &[u16] {
    let to = to.min(units.len());
    units.get(from.min(to)..to).unwrap_or_default()
}

#[must_use]
pub(crate) fn is_blank(unit: u16) -> bool {
    unit == 0x20 || unit == 0x09
}

#[must_use]
pub(crate) fn is_line_terminator(unit: u16) -> bool {
    matches!(unit, LF | CR | LS | PS)
}

/// `trim()`.
#[must_use]
pub(crate) fn trim(units: &[u16]) -> &[u16] {
    let start = units.iter().position(|u| !is_js_whitespace(*u)).unwrap_or(units.len());
    let end =
        units.iter().rposition(|u| !is_js_whitespace(*u)).map_or(start, |at| at.saturating_add(1));
    slice(units, start, end)
}

/// `trim()` of a string.
#[must_use]
pub(crate) fn trim_str(text: &str) -> String {
    decode(trim(&encode(text)))
}

/// `replace(/\s+/g, ' ').trim()`.
#[must_use]
pub(crate) fn collapse_whitespace(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut in_run = false;
    for unit in units {
        if is_js_whitespace(*unit) {
            if !in_run {
                out.push(0x20);
            }
            in_run = true;
        } else {
            out.push(*unit);
            in_run = false;
        }
    }
    trim(&out).to_vec()
}

/// The order `String#<` gives: by code unit.
#[must_use]
pub(crate) fn compare(a: &str, b: &str) -> core::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn slice_clamps_like_javascript() {
        let units = encode("abcd");
        assert_eq!(decode(slice(&units, 1, 3)), "bc");
        assert_eq!(decode(slice(&units, 3, 1)), "");
        assert_eq!(decode(slice(&units, 2, 99)), "cd");
        assert_eq!(decode(slice(&units, 99, 100)), "");
    }

    #[test]
    fn whitespace_collapses_and_trims_by_the_script_set() {
        assert_eq!(decode(&collapse_whitespace(&encode(" a \n\t b\u{a0}\u{3000}c "))), "a b c");
        assert_eq!(decode(&collapse_whitespace(&encode(" \u{feff} "))), "");
        assert_eq!(trim_str("\u{2028} x \u{85}"), "x \u{85}");
    }

    #[test]
    fn an_unpaired_surrogate_reads_as_the_replacement_character() {
        assert_eq!(decode(&[0xd83d, 0x61]), "\u{fffd}a");
    }

    #[test]
    fn strings_order_by_code_unit_not_by_scalar() {
        use core::cmp::Ordering::{Greater, Less};
        // U+FF5E is above U+10000's surrogates in code points, below in units.
        assert_eq!(compare("\u{10000}", "\u{ff5e}"), Less);
        assert_eq!(compare("b", "a"), Greater);
    }
}

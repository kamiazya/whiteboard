//! UTF-16 string operations.
//!
//! JS strings are sequences of UTF-16 code units: `.length`, ordering and
//! every offset a contract carries count those units, while `str::len`
//! counts UTF-8 bytes. Any length or offset that crosses to TypeScript is
//! computed here.

/// The length of `s` in UTF-16 code units — what JS `s.length` answers.
#[must_use]
pub fn len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Whether a code unit is ECMAScript `\s` — what a JS regex's `\s` matches,
/// which is not Unicode `White_Space`: it takes U+FEFF and leaves U+0085 out.
#[must_use]
pub fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff
    )
}

#[cfg(test)]
mod tests {
    use super::{is_js_whitespace, len};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn counts_code_units_not_bytes_or_chars() {
        assert_eq!(len(""), 0);
        assert_eq!(len("abc"), 3);
        // U+00E9 is two UTF-8 bytes and one code unit.
        assert_eq!(len("\u{e9}"), 1);
        // An astral code point is a surrogate pair: two units.
        assert_eq!(len("a\u{1F600}"), 3);
    }

    #[test]
    fn whitespace_is_ecmascript_s() {
        let spaces = [
            0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x2028,
            0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
        ];
        for unit in spaces {
            assert!(is_js_whitespace(unit), "{unit:#x}");
        }
        for unit in [0x08, 0x0e, 0x1f, 0x21, 0x85, 0x9f, 0xa1, 0x1fff, 0x200b, 0x2027, 0x202a] {
            assert!(!is_js_whitespace(unit), "{unit:#x}");
        }
    }
}

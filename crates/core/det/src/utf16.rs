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

#[cfg(test)]
mod tests {
    use super::len;
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
}

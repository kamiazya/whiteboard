//! Deal with bytes, chars, and kinds.

use crate::vendored::util::unicode::PUNCTUATION;
use alloc::string::String;

/// Character kinds.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// Whitespace.
    ///
    /// ## Example
    ///
    /// ```markdown
    /// > | **a_b_ c**.
    ///    ^      ^    ^
    /// ```
    Whitespace,
    /// Punctuation.
    ///
    /// ## Example
    ///
    /// ```markdown
    /// > | **a_b_ c**.
    ///     ^^ ^ ^    ^
    /// ```
    Punctuation,
    /// Everything else.
    ///
    /// ## Example
    ///
    /// ```markdown
    /// > | **a_b_ c**.
    ///       ^ ^  ^
    /// ```
    Other,
}

/// Get a [`char`][] right before `index` in bytes (`&[u8]`).
///
/// In most cases, markdown operates on ASCII bytes.
/// In a few cases, it is unicode aware, so we need to find an actual char.
pub(crate) fn before_index(bytes: &[u8], index: usize) -> Option<char> {
    let start = index.saturating_sub(4);
    String::from_utf8_lossy(&bytes[start..index]).chars().last()
}

/// Get a [`char`][] right at `index` in bytes (`&[u8]`).
///
/// In most cases, markdown operates on ASCII bytes.
/// In a few cases, it is unicode aware, so we need to find an actual char.
pub(crate) fn after_index(bytes: &[u8], index: usize) -> Option<char> {
    let end = if index + 4 > bytes.len() { bytes.len() } else { index + 4 };
    String::from_utf8_lossy(&bytes[index..end]).chars().next()
}

/// Classify a char at `index` in bytes (`&[u8]`).
pub(crate) fn kind_after_index(bytes: &[u8], index: usize) -> Kind {
    if index == bytes.len() {
        Kind::Whitespace
    } else {
        let byte = bytes[index];
        if byte.is_ascii_whitespace() {
            Kind::Whitespace
        } else if byte.is_ascii_punctuation() {
            Kind::Punctuation
        } else if byte.is_ascii_alphanumeric() {
            Kind::Other
        } else {
            // Otherwise: seems to be an ASCII control, so it seems to be a
            // non-ASCII `char`.
            classify_opt(after_index(bytes, index))
        }
    }
}

/// Classify whether a `char` represents whitespace, punctuation, or something
/// else.
///
/// Used for attention (emphasis, strong), whose sequences can open or close
/// based on the class of surrounding characters.
///
/// ## References
///
/// * [`micromark-util-classify-character` in `micromark`](https://github.com/micromark/micromark/blob/main/packages/micromark-util-classify-character/dev/index.js)
pub(crate) fn classify(char: char) -> Kind {
    // Unicode whitespace.
    if char.is_whitespace() {
        Kind::Whitespace
    }
    // Unicode punctuation.
    else if char.is_ascii_punctuation() || PUNCTUATION.binary_search(&char).is_ok() {
        Kind::Punctuation
    }
    // Everything else.
    else {
        Kind::Other
    }
}

/// Like [`classify`], but supports eof as whitespace.
pub(crate) fn classify_opt(char_opt: Option<char>) -> Kind {
    char_opt.map_or(Kind::Whitespace, classify)
}

#[cfg(test)]
mod tests {
    use super::*;
    // On wasm32 the same tests run under Node (QR-21 layer 3).
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn test_classify() {
        assert_eq!(classify(' '), Kind::Whitespace, "should classify whitespace");

        assert_eq!(classify('.'), Kind::Punctuation, "should classify punctuation");

        assert_eq!(classify('a'), Kind::Other, "should classify other");
    }

    #[test]
    fn the_punctuation_table_is_sorted_for_the_binary_search() {
        assert!(PUNCTUATION.windows(2).all(|pair| pair[0] < pair[1]));
    }
}

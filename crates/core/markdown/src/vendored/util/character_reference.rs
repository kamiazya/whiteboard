//! Helpers for character references.

use crate::vendored::util::constant::{
    CHARACTER_REFERENCE_DECIMAL_SIZE_MAX, CHARACTER_REFERENCE_HEXADECIMAL_SIZE_MAX,
    CHARACTER_REFERENCE_NAMED_SIZE_MAX, CHARACTER_REFERENCES, CHARACTER_REFERENCES_HTML_4,
};
use alloc::string::String;
use core::str;

/// Decode named character references.
///
/// Turn the name coming from a named character reference (without the `&` or
/// `;`) into a string.
/// This looks the given string up at `0` in the tuples of
/// `CHARACTER_REFERENCES` (or `CHARACTER_REFERENCES_HTML_4`)
/// and then takes the corresponding value from `1`.
///
/// The `html5` boolean is used for named character references, and specifier
/// whether the 2125 names from HTML 5 or the 252 names from HTML 4 are
/// supported.
///
/// The result is `String` instead of `char` because named character references
/// can expand into multiple characters.
///
/// ## Examples
///
/// ```rust ignore
/// use markdown::util::decode_character_reference::decode_named;
///
/// assert_eq!(decode_named("amp", true), "&");
/// assert_eq!(decode_named("AElig", true), "Æ");
/// assert_eq!(decode_named("aelig", true), "æ");
/// ```
///
/// ## References
///
/// * [`wooorm/decode-named-character-reference`](https://github.com/wooorm/decode-named-character-reference)
/// * [*§ 2.5 Entity and numeric character references* in `CommonMark`](https://spec.commonmark.org/0.31/#entity-and-numeric-character-references)
pub(crate) fn decode_named(value: &str, html5: bool) -> Option<String> {
    let mut iter =
        if html5 { CHARACTER_REFERENCES.iter() } else { CHARACTER_REFERENCES_HTML_4.iter() };
    iter.find(|d| d.0 == value).map(|d| d.1.into())
}

/// Decode numeric character references.
///
/// Turn the number (in string form as either hexadecimal or decimal) coming
/// from a numeric character reference into a string.
/// The base of the string form must be passed as the `radix` parameter, as
/// `10` (decimal) or `16` (hexadecimal).
///
/// This returns a `String` form of the associated character or a replacement
/// character for C0 control characters (except for ASCII whitespace), C1
/// control characters, lone surrogates, noncharacters, and out of range
/// characters.
///
/// ## Examples
///
/// ```rust ignore
/// use markdown::util::decode_character_reference::decode_numeric;
///
/// assert_eq!(decode_numeric("123", 10), "{");
/// assert_eq!(decode_numeric("9", 16), "\t");
/// assert_eq!(decode_numeric("0", 10), "�"); // Not allowed.
/// ```
///
/// ## Panics
///
/// This function panics if a invalid string or an out of bounds valid string
/// is given.
/// It is expected that figuring out whether a number is allowed is handled in
/// the parser.
/// When `markdown-rs` is used, this function never panics.
///
/// ## References
///
/// * [`micromark-util-decode-numeric-character-reference` in `micromark`](https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference)
/// * [*§ 2.5 Entity and numeric character references* in `CommonMark`](https://spec.commonmark.org/0.31/#entity-and-numeric-character-references)
pub(crate) fn decode_numeric(value: &str, radix: u32) -> String {
    if let Some(char) = u32::from_str_radix(value, radix).ok().and_then(char::from_u32)
        && !matches!(char,
            // C0 except for HT, LF, FF, CR, space.
            '\0'..='\u{08}' | '\u{0B}' | '\u{0E}'..='\u{1F}' |
            // Control character (DEL) of C0, and C1 controls.
            '\u{7F}'..='\u{9F}'
            // Lone surrogates, noncharacters, and out of range are handled by
            // Rust.
        )
    {
        return char.into();
    }

    char::REPLACEMENT_CHARACTER.into()
}

/// Decode a character reference.
///
/// This turns the number (in string form as either hexadecimal or decimal) or
/// name from a character reference into a string.
///
/// The marker specifies the format: `#` for hexadecimal, `x` for decimal, and
/// `&` for named.
///
/// The `html5` boolean is used for named character references, and specifier
/// whether the 2125 names from HTML 5 or the 252 names from HTML 4 are
/// supported.
///
/// A `marker` that is none of `b'&'`, `b'x'` and `b'#'` decodes nothing.
pub(crate) fn decode(value: &str, marker: u8, html5: bool) -> Option<String> {
    match marker {
        b'#' => Some(decode_numeric(value, 10)),
        b'x' => Some(decode_numeric(value, 16)),
        b'&' => decode_named(value, html5),
        _ => None,
    }
}

/// Get the maximum size of a value for different kinds of references.
///
/// The value is the stuff after the markers, before the `;`.
///
/// A `marker` that is none of `b'&'`, `b'x'` and `b'#'` decodes nothing.
pub(crate) fn value_max(marker: u8) -> usize {
    match marker {
        b'&' => CHARACTER_REFERENCE_NAMED_SIZE_MAX,
        b'x' => CHARACTER_REFERENCE_HEXADECIMAL_SIZE_MAX,
        b'#' => CHARACTER_REFERENCE_DECIMAL_SIZE_MAX,
        _ => 0,
    }
}

/// Get a test to check if a byte is allowed as a value for different kinds of
/// references.
///
/// The value is the stuff after the markers, before the `;`.
///
/// A `marker` that is none of `b'&'`, `b'x'` and `b'#'` decodes nothing.
pub(crate) fn value_test(marker: u8) -> fn(&u8) -> bool {
    match marker {
        b'&' => u8::is_ascii_alphanumeric,
        b'x' => u8::is_ascii_hexdigit,
        b'#' => u8::is_ascii_digit,
        _ => |_| false,
    }
}

/// Decode the escapes and character references of a string the way a label's
/// text is read: `\*` is `*`, `&amp;` is `&`, and what is neither stays as
/// written.
pub(crate) fn decode_string(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut result = String::with_capacity(value.len());
    let mut start = 0;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        let mut decoded: Option<(usize, String)> = None;
        if byte == b'\\' && bytes.get(index + 1).is_some_and(u8::is_ascii_punctuation) {
            decoded = Some((index + 2, value[index + 1..index + 2].to_string()));
        } else if byte == b'&' {
            decoded = reference_at(value, index);
        }
        if let Some((end, text)) = decoded {
            result.push_str(&value[start..index]);
            result.push_str(&text);
            index = end;
            start = end;
        } else {
            index += 1;
        }
    }
    result.push_str(&value[start..]);
    result
}

/// The character reference starting at `at` (an `&`): where it ends and what it decodes to.
fn reference_at(value: &str, at: usize) -> Option<(usize, String)> {
    let bytes = value.as_bytes();
    let (marker, from, max) = match (bytes.get(at + 1), bytes.get(at + 2)) {
        (Some(b'#'), Some(b'x' | b'X')) => (b'x', at + 3, 6),
        (Some(b'#'), _) => (b'#', at + 2, 7),
        _ => (b'&', at + 1, 31),
    };
    let test = value_test(marker);
    let mut end = from;
    while end < bytes.len() && test(&bytes[end]) {
        end += 1;
    }
    let length = end - from;
    if length == 0 || length > max || bytes.get(end) != Some(&b';') {
        return None;
    }
    decode(&value[from..end], marker, true).map(|text| (end + 1, text))
}

//! XML text and attribute escaping, with the removal of characters XML 1.0
//! cannot carry at all.

/// XML 1.0 (section 2.2) permits only tab, line feed and carriage return among
/// the C0 controls; every other C0 and C1 control is not a character at all,
/// nor are U+FFFE and U+FFFF. (A lone surrogate, the TypeScript's other case,
/// cannot be held by a Rust string.)
fn is_xml_invalid(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' | '\u{7F}'..='\u{9F}')
        || matches!(c, '\u{FFFE}' | '\u{FFFF}')
}

/// `value` without the characters XML cannot carry. Exposed so a check that
/// judges the EMITTED bytes applies the same removal first.
#[must_use]
pub fn strip_xml_invalid_chars(value: &str) -> String {
    value.chars().filter(|c| !is_xml_invalid(*c)).collect()
}

/// Escapes `& < >` for use inside SVG text content.
#[must_use]
pub fn escape_xml_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars().filter(|c| !is_xml_invalid(*c)) {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            other => out.push(other),
        }
    }
    out
}

/// Escapes `& < > " '` for use inside a quoted attribute value.
#[must_use]
pub fn escape_xml_attr(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars().filter(|c| !is_xml_invalid(*c)) {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{escape_xml_attr, escape_xml_text, strip_xml_invalid_chars};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn text_escapes_the_markup_characters_only() {
        assert_eq!(escape_xml_text("a & b < c > d \"q\" 'r'"), "a &amp; b &lt; c &gt; d \"q\" 'r'");
        assert_eq!(escape_xml_text("&amp;"), "&amp;amp;");
    }

    #[test]
    fn an_attribute_escapes_the_quotes_too() {
        assert_eq!(
            escape_xml_attr("a & b < c > d \"q\" 'r'"),
            "a &amp; b &lt; c &gt; d &quot;q&quot; &apos;r&apos;"
        );
    }

    #[test]
    fn characters_xml_cannot_carry_are_removed_and_the_rest_kept() {
        let invalid = ['\u{0}', '\u{8}', '\u{B}', '\u{C}', '\u{E}', '\u{1F}', '\u{7F}', '\u{85}'];
        let invalid = invalid.iter().chain(&['\u{9F}', '\u{FFFE}', '\u{FFFF}']);
        for c in invalid {
            assert_eq!(strip_xml_invalid_chars(&format!("a{c}b")), "ab", "{c:?}");
            assert_eq!(escape_xml_text(&format!("a{c}b")), "ab");
            assert_eq!(escape_xml_attr(&format!("a{c}b")), "ab");
        }
        for c in ['\t', '\n', '\r', ' ', '\u{20}', '\u{A0}', '\u{100}', '\u{FFFD}', '\u{10000}'] {
            assert_eq!(strip_xml_invalid_chars(&format!("a{c}b")), format!("a{c}b"), "{c:?}");
        }
    }
}

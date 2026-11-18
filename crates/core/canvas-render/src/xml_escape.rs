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
    fn every_c0_control_is_kept_exactly_when_xml_admits_it() {
        // XML 1.0 section 2.2 `Char` admits tab, line feed and carriage return
        // of the 32 C0 controls, written as code points so the table shares
        // nothing with the predicate it judges.
        for code in 0u32..0x20 {
            let c = char::from_u32(code).unwrap_or_default();
            let kept = matches!(code, 0x09 | 0x0A | 0x0D);
            let text = format!("a{c}b");
            let want = if kept { text.clone() } else { "ab".to_owned() };
            assert_eq!(strip_xml_invalid_chars(&text), want, "U+{code:04X}");
            assert_eq!(escape_xml_text(&text), want, "U+{code:04X}");
            assert_eq!(escape_xml_attr(&text), want, "U+{code:04X}");
        }
    }

    #[test]
    fn the_c1_range_and_the_noncharacters_are_removed_and_the_rest_kept() {
        for code in (0x7Fu32..=0x9F).chain([0xFFFE, 0xFFFF]) {
            let c = char::from_u32(code).unwrap_or_default();
            assert_eq!(strip_xml_invalid_chars(&format!("a{c}b")), "ab", "U+{code:04X}");
            assert_eq!(escape_xml_text(&format!("a{c}b")), "ab");
            assert_eq!(escape_xml_attr(&format!("a{c}b")), "ab");
        }
        for c in [' ', '\u{A0}', '\u{100}', '\u{FFFD}', '\u{10000}'] {
            assert_eq!(strip_xml_invalid_chars(&format!("a{c}b")), format!("a{c}b"), "{c:?}");
        }
    }
}

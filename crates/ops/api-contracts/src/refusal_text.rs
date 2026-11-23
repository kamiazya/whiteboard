//! The filters a refusal's message template names (`{name|filter}`), each the
//! JavaScript the TypeScript interpreter runs: `JSON.stringify`, `trim`,
//! `join`, and the plural `s`.

use std::fmt::Write as _;

/// `String.prototype.trim`'s whitespace, which is not Rust's: it keeps U+0085
/// and trims U+FEFF.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `JSON.stringify(text)`: quoted, with `"` and `\` escaped, the short forms
/// for the controls that have one and `\u00xx` for the rest.
pub(crate) fn json(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `text.trim()`.
pub(crate) fn trim(text: &str) -> String {
    text.trim_matches(is_js_space).to_owned()
}

/// `"s"` unless the count is one.
pub(crate) fn plural_s(count: u64) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// `items.join(", ")`.
pub(crate) fn list(items: &[String]) -> String {
    items.join(", ")
}

/// `items.join(" and ")`.
pub(crate) fn and_list(items: &[String]) -> String {
    items.join(" and ")
}

/// Each item through `JSON.stringify`, joined by `", "`.
pub(crate) fn json_list(items: &[String]) -> String {
    items.iter().map(|item| json(item)).collect::<Vec<_>>().join(", ")
}

/// Each item in plain double quotes (no escaping), joined by `", "`.
pub(crate) fn quoted_list(items: &[String]) -> String {
    items.iter().map(|item| format!("\"{item}\"")).collect::<Vec<_>>().join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn json_quotes_as_json_stringify_does() {
        assert_eq!(json("plain é —"), "\"plain é —\"");
        assert_eq!(json("a\"b\\c"), "\"a\\\"b\\\\c\"");
        assert_eq!(json("\u{8}\u{c}\n\r\t"), "\"\\b\\f\\n\\r\\t\"");
        assert_eq!(json("\u{0}\u{1}\u{1f}"), "\"\\u0000\\u0001\\u001f\"");
        // DEL and the line separators are written as they are, as JavaScript does.
        assert_eq!(json("\u{7f}\u{2028}\u{2029}"), "\"\u{7f}\u{2028}\u{2029}\"");
        assert_eq!(json(""), "\"\"");
    }

    #[test]
    fn json_agrees_with_serde_json_on_every_character_below_the_first_non_ascii_one() {
        for code in 0u32..0x100 {
            let text = char::from_u32(code).unwrap().to_string();
            assert_eq!(json(&text), serde_json::to_string(&text).unwrap(), "{code:#x}");
        }
    }

    #[test]
    fn trim_removes_the_whitespace_javascript_removes_and_no_more() {
        for space in [
            '\u{9}', '\u{a}', '\u{b}', '\u{c}', '\u{d}', ' ', '\u{a0}', '\u{1680}', '\u{2000}',
            '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
        ] {
            assert_eq!(trim(&format!("{space}x y{space}")), "x y", "{:#x}", u32::from(space));
        }
        // U+0085 is Rust whitespace and not JavaScript's; U+200B is neither.
        assert_eq!(trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
        assert_eq!(trim("\u{200b}x"), "\u{200b}x");
        assert_eq!(trim("\u{8}x\u{e}"), "\u{8}x\u{e}");
        assert_eq!(trim("\u{1fff}x\u{200b}"), "\u{1fff}x\u{200b}");
        assert_eq!(trim("   "), "");
    }

    #[test]
    fn plural_s_is_silent_for_one_only() {
        assert_eq!(plural_s(1), "");
        assert_eq!(plural_s(0), "s");
        assert_eq!(plural_s(2), "s");
    }

    #[test]
    fn lists_join_as_their_filters_say() {
        let items = strings(&["a\"", "b"]);
        assert_eq!(list(&items), "a\", b");
        assert_eq!(and_list(&items), "a\" and b");
        assert_eq!(json_list(&items), "\"a\\\"\", \"b\"");
        assert_eq!(quoted_list(&items), "\"a\"\", \"b\"");
        let none: Vec<String> = Vec::new();
        assert_eq!(
            (list(&none), and_list(&none), json_list(&none), quoted_list(&none)),
            (String::new(), String::new(), String::new(), String::new())
        );
        assert_eq!(list(&strings(&["only"])), "only");
    }
}

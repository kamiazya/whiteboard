//! The two bounds a reference rewrite can break, and the refusal that says so.
//!
//! The numbers and phrases are `packages/model`'s `MARKDOWN_MAX_CHARS`,
//! `NODE_TEXT_MAX_CHARS` and their `*_LIMIT_PHRASE`s, which have no Rust home
//! yet.

use std::fmt::Write as _;

/// A markdown body's bound, in UTF-16 units.
pub const MARKDOWN_MAX_CHARS: usize = 262_144;
/// A text node's bound, in UTF-16 units.
pub const NODE_TEXT_MAX_CHARS: usize = 8192;

const MARKDOWN_LIMIT_PHRASE: &str =
    "the 262144-character limit for one document; split the content across documents";
const NODE_TEXT_LIMIT_PHRASE: &str = "the 8192-character limit for one node; split it across nodes, or put it in a markdown document and embed that";

/// Whether a text going from `before` to `after` units breaks a bound of
/// `max`: only growth that ends past it does, so a text stored longer before
/// the bound existed still takes an edit that shortens it.
#[must_use]
pub const fn grows_past(max: usize, before: usize, after: usize) -> bool {
    after > max && after > before
}

/// Which bound a refused rewrite broke, and by how much. No container is
/// named: a rewrite is planned from plain content, which has none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Breach {
    Body { chars: usize },
    NodeText { chars: usize, node_id: String },
}

/// A rewrite refused because the text it would leave is past the ceiling every
/// other write to it is held to. Nothing was planned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceRewriteTooLarge {
    pub breach: Breach,
}

impl ReferenceRewriteTooLarge {
    /// The class a caller tells this refusal by.
    pub const NAME: &'static str = "ReferenceRewriteTooLargeError";

    #[must_use]
    pub fn message(&self) -> String {
        match &self.breach {
            Breach::Body { chars } => format!(
                "The links would make the document body {chars} characters long, past {MARKDOWN_LIMIT_PHRASE}"
            ),
            Breach::NodeText { chars, node_id } => format!(
                "The links would give node {} {chars} characters of text, past {NODE_TEXT_LIMIT_PHRASE}",
                json_string(node_id)
            ),
        }
    }
}

/// `JSON.stringify` of a string: quotes, the short escapes, `\u00xx` for the
/// other control characters, everything else as written.
fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
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

#[cfg(test)]
mod tests {
    use super::{Breach, ReferenceRewriteTooLarge, grows_past, json_string};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    #[test]
    fn only_growth_past_the_bound_breaks_it() {
        assert!(grows_past(10, 5, 11));
        assert!(!grows_past(10, 5, 10));
        assert!(!grows_past(10, 20, 15));
        assert!(!grows_past(10, 20, 20));
    }

    #[test]
    fn a_node_id_is_quoted_as_json_quotes_it() {
        assert_eq!(json_string("a\"b\\c\n\u{1}\u{7f}日"), "\"a\\\"b\\\\c\\n\\u0001\u{7f}日\"");
        assert_eq!(json_string("\u{8}\u{c}\r\t"), "\"\\b\\f\\r\\t\"");
        let error = ReferenceRewriteTooLarge {
            breach: Breach::NodeText { chars: 9000, node_id: "\t".to_owned() },
        };
        assert!(error.message().starts_with("The links would give node \"\\t\" 9000 characters"));
    }
}

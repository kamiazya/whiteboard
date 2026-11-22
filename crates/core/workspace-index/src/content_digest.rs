//! The identity of a document's content as a short string: what a picture of
//! the document is a picture of. A hash of the content in a canonical JSON
//! form (keys in UTF-16 order at every depth, a container that holds nothing
//! dropped), so the same content is the same digest on every replica.
//! cyrb53 is a cache key, not a security hash: it is synchronous and
//! dependency-free, and sixty-four bits of hex make an accidental collision
//! between two states of one document a non-event.

use std::fmt::Write as _;
use whiteboard_det::format::js_number_to_string;
use whiteboard_model::Value;

/// A container that holds nothing is the same as no container: `""` or an
/// object with no keys. Nested empties stay, since inside a container an empty
/// object is content.
fn holds_nothing(value: &Value) -> bool {
    match value {
        Value::String(text) => text.is_empty(),
        Value::Map(entries) => entries.is_empty(),
        _ => false,
    }
}

/// `JSON.stringify` of a string: the quote, the backslash and the control
/// characters escaped, everything else as it is.
fn quote(out: &mut String, text: &str) {
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
}

/// A scalar as `JSON.stringify` writes it, or `None` for a list or a mapping.
fn scalar(value: &Value) -> Option<String> {
    Some(match value {
        Value::Bool(b) => b.to_string(),
        Value::Number(n) if n.is_finite() => js_number_to_string(*n),
        Value::Null | Value::BigInt(_) | Value::Number(_) => "null".to_owned(),
        Value::String(text) => {
            let mut out = String::new();
            quote(&mut out, text);
            out
        }
        Value::Seq(_) | Value::Map(_) => return None,
    })
}

enum Pending<'a> {
    Text(String),
    Value(&'a Value),
}

/// The members of a list or a mapping pushed so they pop in order, each led by
/// its separator and key.
fn push_members<'a>(stack: &mut Vec<Pending<'a>>, value: &'a Value) {
    let members: Vec<(Option<&'a str>, &'a Value)> = match value {
        Value::Seq(items) => items.iter().map(|item| (None, item)).collect(),
        Value::Map(entries) => {
            let mut sorted: Vec<(Option<&str>, &Value)> =
                entries.iter().map(|(key, item)| (Some(key.as_str()), item)).collect();
            sorted.sort_by(|a, b| {
                a.0.unwrap_or("").encode_utf16().cmp(b.0.unwrap_or("").encode_utf16())
            });
            sorted
        }
        _ => return,
    };
    for (index, (key, item)) in members.into_iter().enumerate().rev() {
        let mut head = if index == 0 { String::new() } else { ",".to_owned() };
        if let Some(key) = key {
            quote(&mut head, key);
            head.push(':');
        }
        if let Some(leaf) = scalar(item) {
            stack.push(Pending::Text(head + &leaf));
            continue;
        }
        stack.push(Pending::Value(item));
        if !head.is_empty() {
            stack.push(Pending::Text(head));
        }
    }
}

/// Writes a scalar whole, or the opening of a list or mapping with the rest
/// of it left on the stack.
fn open_value<'a>(out: &mut String, stack: &mut Vec<Pending<'a>>, value: &'a Value) {
    if let Some(leaf) = scalar(value) {
        out.push_str(&leaf);
        return;
    }
    let (open, close) = if matches!(value, Value::Seq(_)) { ('[', ']') } else { ('{', '}') };
    out.push(open);
    stack.push(Pending::Text(close.to_string()));
    push_members(stack, value);
}

/// The value as JSON with every mapping's keys sorted by UTF-16 code unit, at
/// any depth. Written with an explicit stack: a stored value is as deep as its
/// writer chose.
#[must_use]
pub fn stable_stringify(root: &Value) -> String {
    let mut out = String::new();
    let mut stack = vec![Pending::Value(root)];
    while let Some(next) = stack.pop() {
        match next {
            Pending::Text(text) => out.push_str(&text),
            Pending::Value(value) => open_value(&mut out, &mut stack, value),
        }
    }
    out
}

/// cyrb53 over UTF-16 code units, as 16 hex digits.
fn cyrb53(input: &str) -> String {
    let (mut h1, mut h2) = (0xdead_beef_u32, 0x41c6_ce57_u32);
    for unit in input.encode_utf16() {
        let unit = u32::from(unit);
        h1 = (h1 ^ unit).wrapping_mul(2_654_435_761);
        h2 = (h2 ^ unit).wrapping_mul(1_597_334_677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2_246_822_507);
    h1 ^= (h2 ^ (h2 >> 13)).wrapping_mul(3_266_489_909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2_246_822_507);
    h2 ^= (h1 ^ (h1 >> 13)).wrapping_mul(3_266_489_909);
    format!("{h2:08x}{h1:08x}")
}

/// The digest of a document's content containers, keyed by their names. Key
/// order and container order are irrelevant to the answer; only values are.
#[must_use]
pub fn content_digest_of(content: &[(String, Value)]) -> String {
    let held: Vec<(String, Value)> =
        content.iter().filter(|(_, value)| !holds_nothing(value)).cloned().collect();
    cyrb53(&stable_stringify(&Value::Map(held)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn text(s: &str) -> Value {
        Value::String(s.to_owned())
    }

    fn map(entries: Vec<(&str, Value)>) -> Value {
        Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
    }

    #[test]
    fn a_document_with_no_content_is_the_digest_of_an_empty_object() {
        assert_eq!(content_digest_of(&[]), "f6bbc27f5a56d1e7");
        let empties = [("body".to_owned(), text("")), ("nodes".to_owned(), map(vec![]))];
        assert_eq!(content_digest_of(&empties), "f6bbc27f5a56d1e7");
    }

    #[test]
    fn content_is_hashed_as_the_typescript_hashes_it() {
        let content = [
            (
                "nodes".to_owned(),
                map(vec![(
                    "a",
                    map(vec![
                        ("y", Value::Seq(vec![Value::Number(1.0), Value::Null, Value::Bool(true)])),
                        ("x", Value::Number(1.5)),
                    ]),
                )]),
            ),
            ("body".to_owned(), text("héllo 😀")),
        ];
        assert_eq!(content_digest_of(&content), "e119a4e6abe1d8a7");
        let escaped = [("a".to_owned(), text("\u{1}\"x"))];
        assert_eq!(content_digest_of(&escaped), "5f1c0c7e52505cbe");
    }

    #[test]
    fn only_a_whole_container_that_holds_nothing_is_dropped() {
        let kept = [("nodes".to_owned(), Value::Seq(vec![]))];
        assert_ne!(content_digest_of(&kept), content_digest_of(&[]));
        let nested = [("nodes".to_owned(), map(vec![("a", map(vec![]))]))];
        assert_ne!(content_digest_of(&nested), content_digest_of(&[]));
        let zero = [("nodes".to_owned(), Value::Number(0.0))];
        assert_ne!(content_digest_of(&zero), content_digest_of(&[]));
    }

    #[test]
    fn keys_sort_by_code_unit_and_scalars_are_written_as_json_writes_them() {
        let value = map(vec![
            ("\u{e000}", Value::Number(-0.0)),
            ("\u{1f600}", Value::Number(1e21)),
            ("b", Value::Number(f64::NAN)),
            ("a", Value::Seq(vec![Value::Bool(false), text("é\n\u{8}\u{c}\r\t\\")])),
        ]);
        assert_eq!(
            stable_stringify(&value),
            "{\"a\":[false,\"é\\n\\b\\f\\r\\t\\\\\"],\"b\":null,\"\u{1f600}\":1e+21,\"\u{e000}\":0}"
        );
    }

    #[test]
    fn a_deeply_nested_value_is_written_whole() {
        let mut value = Value::Number(1.0);
        for _ in 0..1_000 {
            value = Value::Seq(vec![value]);
        }
        let written = stable_stringify(&value);
        assert_eq!(written.len(), 2_001);
        assert!(written.starts_with("[[[") && written.ends_with("]]]"));
    }

    #[test]
    fn members_are_separated_and_a_big_integer_is_null() {
        assert_eq!(stable_stringify(&Value::Seq(vec![])), "[]");
        assert_eq!(stable_stringify(&map(vec![])), "{}");
        let value = Value::Seq(vec![
            Value::BigInt("9".into()),
            map(vec![("k", Value::Seq(vec![]))]),
            Value::Null,
        ]);
        assert_eq!(stable_stringify(&value), "[null,{\"k\":[]},null]");
    }
}

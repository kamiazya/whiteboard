//! `JSON.stringify` of a value tree, compact, with no replacer.

use std::fmt::Write as _;
use whiteboard_det::format::js_number_to_string;
use whiteboard_model::{Map, Value, array_index};

/// The deepest nesting written; a caller-built tree has no depth of its own.
pub const MAX_DEPTH: usize = 128;

/// Why a value has no JSON text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Unwritable {
    /// Nesting past [`MAX_DEPTH`].
    TooDeep,
    /// An integer past 2^53 kept as digits, which `JSON.stringify` throws on.
    BigInt,
}

pub(super) fn stringify(value: &Value) -> Result<String, Unwritable> {
    let mut out = String::new();
    write(&mut out, value, 0)?;
    Ok(out)
}

fn write(out: &mut String, value: &Value, depth: usize) -> Result<(), Unwritable> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        // JSON has no spelling for a number that is not finite.
        Value::Number(n) if !n.is_finite() => out.push_str("null"),
        Value::Number(n) => out.push_str(&js_number_to_string(*n)),
        Value::BigInt(_) => return Err(Unwritable::BigInt),
        Value::String(text) => quote(out, text),
        Value::Seq(items) => {
            let inner = descend(depth)?;
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write(out, item, inner)?;
            }
            out.push(']');
        }
        Value::Map(entries) => {
            let inner = descend(depth)?;
            out.push('{');
            for (at, (key, item)) in enumerated(entries).into_iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                quote(out, key);
                out.push(':');
                write(out, item, inner)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn descend(depth: usize) -> Result<usize, Unwritable> {
    if depth >= MAX_DEPTH { Err(Unwritable::TooDeep) } else { Ok(depth.saturating_add(1)) }
}

/// The entries in the order an object enumerates them: integer-like keys
/// ascending, then the rest as written.
fn enumerated(entries: &Map) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> =
        entries.iter().filter_map(|(key, item)| Some((array_index(key)?, key, item))).collect();
    indexed.sort_by_key(|entry| entry.0);
    let rest = entries.iter().filter(|(key, _)| array_index(key).is_none());
    indexed.into_iter().map(|(_, key, item)| (key, item)).chain(rest.map(|(k, v)| (k, v))).collect()
}

/// A string as `JSON.stringify` quotes it: the two quote characters and the
/// control characters escaped, everything else as it is.
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

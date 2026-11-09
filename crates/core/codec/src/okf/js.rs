//! JavaScript's own rules, which the TypeScript envelope is built on: the
//! order an object enumerates its keys in, `String.prototype.trim`'s idea of
//! white space, and the order `compareCodeUnit` gives strings.

use crate::frontmatter::Value;
use std::cmp::Ordering;
use whiteboard_det::format::js_number_to_string;

/// The index JavaScript gives an array-index key, or `None`.
pub fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    if !canonical || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// `value` with every mapping's keys in the order JavaScript enumerates them:
/// array indices ascending, then the rest as written.
pub fn enumeration_order(value: Value) -> Value {
    match value {
        Value::Seq(items) => Value::Seq(items.into_iter().map(enumeration_order).collect()),
        Value::Map(entries) => {
            let (mut indexed, rest): (Vec<_>, Vec<_>) =
                entries.into_iter().partition(|(key, _)| array_index(key).is_some());
            indexed.sort_by_key(|(key, _)| array_index(key));
            Value::Map(
                indexed
                    .into_iter()
                    .chain(rest)
                    .map(|(key, item)| (key, enumeration_order(item)))
                    .collect(),
            )
        }
        other => other,
    }
}

/// The characters `trim` strips: ECMAScript's `WhiteSpace` and `LineTerminator`.
/// Not `char::is_whitespace`, which counts U+0085 and misses U+FEFF.
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

/// Whether `text.trim() === text`.
pub(super) fn is_trimmed(text: &str) -> bool {
    !text.starts_with(is_js_space) && !text.ends_with(is_js_space)
}

/// `compareCodeUnit`: UTF-16 code unit order, which differs from the byte
/// order of UTF-8 for a supplementary character against U+E000 to U+FFFF.
pub(super) fn compare_code_units(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// Whether Zod's `min(1)` would still run on a value that is not a string and
/// find it short. The check runs on anything with a `length` (it skips only
/// `null` and values without one), so an empty list fails it beside the type
/// error, and so does a mapping whose `length` key does not compare `>= 1`.
pub(super) fn length_below_one(value: &Value) -> bool {
    match value {
        Value::Seq(items) => items.is_empty(),
        Value::Map(entries) => {
            entries.iter().find(|(key, _)| key == "length").is_some_and(|(_, length)| {
                // NaN compares to nothing, and so is not at least one.
                !matches!(
                    to_number(length).partial_cmp(&1.0),
                    Some(Ordering::Equal | Ordering::Greater)
                )
            })
        }
        _ => false,
    }
}

/// `ToNumber` of a value as the relational operator applies it: an object
/// goes through its string form.
fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(flag) => f64::from(u8::from(*flag)),
        Value::Number(n) => *n,
        Value::BigInt(digits) => {
            if digits.starts_with('-') {
                -1.0
            } else {
                1.0
            }
        }
        Value::String(text) => string_to_number(text),
        Value::Seq(_) | Value::Map(_) => string_to_number(&to_js_string(value)),
    }
}

/// `String(value)` for what the YAML reader produces.
fn to_js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(n) => js_number_to_string(*n),
        Value::BigInt(digits) | Value::String(digits) => digits.clone(),
        Value::Seq(items) => items.iter().map(to_js_string).collect::<Vec<_>>().join(","),
        Value::Map(_) => "[object Object]".to_string(),
    }
}

/// `Number(text)` for what is compared with one: white space around,
/// `Infinity`, the prefixed integers and decimal literals; anything else is
/// NaN. The empty string and `-Infinity` need no arm of their own: they fall
/// below one exactly as NaN does.
fn string_to_number(text: &str) -> f64 {
    let text = text.trim_matches(is_js_space);
    if matches!(text, "Infinity" | "+Infinity") {
        return f64::INFINITY;
    }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0o", "0O"], 8), (["0b", "0B"], 2)] {
        if let Some(rest) = prefixes.iter().find_map(|prefix| text.strip_prefix(prefix)) {
            return integer(rest, radix);
        }
    }
    if text.chars().all(|c| c.is_ascii_digit() || ".eE+-".contains(c)) {
        text.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// The digits of `rest` in `radix`, or NaN when one is not. No digits at all
/// read as zero, which is below one just as the NaN `Number` makes of them is.
fn integer(rest: &str, radix: u32) -> f64 {
    rest.chars()
        .try_fold(0.0, |sum, c| Some(sum * f64::from(radix) + f64::from(c.to_digit(radix)?)))
        .unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::is_js_space;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    /// What `trim` strips in the JavaScript engine, recorded by
    /// `packages/codec/src/okf/oracle/js-whitespace.test.ts`.
    const RECORDED: &str =
        include_str!("../../../../../packages/codec/src/okf/oracle/js-whitespace.json");

    #[test]
    fn is_exactly_what_the_engine_strips_for_every_scalar_value() {
        let recorded: Vec<u32> = serde_json::from_str(RECORDED).unwrap_or_default();
        assert!(recorded.len() > 20, "the recording names {} code points", recorded.len());
        let mut stripped = Vec::new();
        for cp in 0..=0x10_ffff_u32 {
            if char::from_u32(cp).is_some_and(is_js_space) {
                stripped.push(cp);
            }
        }
        assert_eq!(stripped, recorded);
    }
}

//! JavaScript's own rules, which the TypeScript envelope is built on: the
//! order an object enumerates its keys in, `String.prototype.trim`'s idea of
//! white space, and the order `compareCodeUnit` gives strings.

use crate::frontmatter::Value;
use std::cmp::Ordering;
use whiteboard_det::format::js_number_to_string;

/// The index JavaScript gives an array-index key, or `None`.
fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    if !canonical || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// `value` with every mapping's keys in the order JavaScript enumerates them:
/// array indices ascending, then the rest as written.
pub(super) fn enumeration_order(value: Value) -> Value {
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

/// `Number(text)`: white space around, empty as zero, `Infinity`, the prefixed
/// integers, and decimal literals; anything else is NaN.
fn string_to_number(text: &str) -> f64 {
    let text = text.trim_matches(is_js_space);
    let digits = |rest: &str, radix: u32| {
        if rest.is_empty() {
            return f64::NAN;
        }
        rest.chars()
            .try_fold(0.0, |sum, c| Some(sum * f64::from(radix) + f64::from(c.to_digit(radix)?)))
            .unwrap_or(f64::NAN)
    };
    match text {
        "" => 0.0,
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ => {
            if let Some(rest) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
                digits(rest, 16)
            } else if let Some(rest) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
                digits(rest, 8)
            } else if let Some(rest) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
                digits(rest, 2)
            } else if text.chars().all(|c| c.is_ascii_digit() || ".eE+-".contains(c)) {
                text.parse().unwrap_or(f64::NAN)
            } else {
                f64::NAN
            }
        }
    }
}

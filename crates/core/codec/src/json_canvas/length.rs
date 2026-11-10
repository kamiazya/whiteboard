//! Zod's length checks on a value that is not a string.
//!
//! `z.string().min(1)` runs its length check on any value that has a `length`
//! (`when` is "not nullish and `length !== undefined`"), and Zod runs a check
//! with a `when` after an `invalid_type` that aborted. So an empty array is
//! refused twice, as the wrong type and as too short, and so is an object whose
//! `length` is not at least one by the host's relational comparison. That
//! comparison coerces: a string is read as `Number(text)`, an array through
//! its `join`, an object as `NaN`.

use whiteboard_det::format::js_number_to_string;
use whiteboard_model::checks::is_js_space;
use whiteboard_model::{Map, Value};

/// Whether `value` has a `length` below one, as the check `min(1)` reads it.
pub(super) fn below_one(value: &Value) -> bool {
    match value {
        Value::Seq(items) => items.is_empty(),
        Value::Map(entries) => length_of(entries).is_some_and(|length| !at_least_one(length)),
        _ => false,
    }
}

fn length_of(entries: &Map) -> Option<&Value> {
    entries.iter().find(|(key, _)| key == "length").map(|(_, length)| length)
}

/// `value >= 1` in JavaScript.
fn at_least_one(value: &Value) -> bool {
    match value {
        Value::Number(n) => *n >= 1.0,
        Value::Bool(b) => *b,
        Value::String(text) => number_of(text) >= 1.0,
        Value::Seq(_) => number_of(&joined(value)) >= 1.0,
        Value::Null | Value::BigInt(_) | Value::Map(_) => false,
    }
}

/// `String(value)` for the arrays `join` reaches.
fn joined(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number_to_string(*n),
        Value::String(text) => text.clone(),
        Value::BigInt(digits) => digits.clone(),
        Value::Seq(items) => items.iter().map(joined).collect::<Vec<_>>().join(","),
        Value::Map(_) => "[object Object]".to_string(),
    }
}

/// `Number(text)`, with `NaN` for what is no number.
fn number_of(text: &str) -> f64 {
    let text = text.trim_matches(is_js_space);
    if text.is_empty() {
        return 0.0;
    }
    if let Some(digits) = radix_digits(text) {
        return digits;
    }
    // `-Infinity` and every other word read as `NaN` below, and neither reaches one.
    if matches!(text, "Infinity" | "+Infinity") {
        return f64::INFINITY;
    }
    // Rust's parser also reads `inf` and `nan`, which JavaScript does not.
    if text.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) {
        text.parse().unwrap_or(f64::NAN)
    } else {
        f64::NAN
    }
}

/// `0x`, `0o` and `0b` literals: only whether they reach one is asked, so a
/// literal is 1 when any digit is not zero and 0 when all are.
fn radix_digits(text: &str) -> Option<f64> {
    let (radix, digits) = match text.get(..2)? {
        "0x" | "0X" => (16, text.get(2..)?),
        "0o" | "0O" => (8, text.get(2..)?),
        "0b" | "0B" => (2, text.get(2..)?),
        _ => return None,
    };
    let valid = !digits.is_empty() && digits.chars().all(|c| c.is_digit(radix));
    Some(if !valid {
        f64::NAN
    } else if digits.chars().all(|c| c == '0') {
        0.0
    } else {
        1.0
    })
}

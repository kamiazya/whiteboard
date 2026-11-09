//! What `yaml` 2.9's core schema makes of a plain scalar.

use super::number::radix_to_f64;
use super::value::Value;

/// A resolved plain scalar.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Core {
    Null,
    Bool(bool),
    /// A number, and whether it was spelled as an integer.
    Number {
        value: f64,
        integer: bool,
    },
    Text,
}

pub(super) fn resolve_plain(text: &str) -> Core {
    match text {
        "" | "~" | "null" | "Null" | "NULL" => return Core::Null,
        "true" | "True" | "TRUE" => return Core::Bool(true),
        "false" | "False" | "FALSE" => return Core::Bool(false),
        _ => {}
    }
    if let Some(octal) = radix_body(text, "0o", |c| matches!(c, '0'..='7')) {
        return Core::Number { value: radix_to_f64(octal, 3), integer: true };
    }
    if is_decimal(text) {
        return Core::Number { value: text.parse().unwrap_or(f64::NAN), integer: true };
    }
    if let Some(hex) = radix_body(text, "0x", |c| c.is_ascii_hexdigit()) {
        return Core::Number { value: radix_to_f64(hex, 4), integer: true };
    }
    if let Some(value) = special_float(text) {
        return Core::Number { value, integer: false };
    }
    if is_exponent_float(text) || is_plain_float(text) {
        return Core::Number { value: text.parse().unwrap_or(f64::NAN), integer: false };
    }
    Core::Text
}

fn special_float(text: &str) -> Option<f64> {
    match text {
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => Some(f64::INFINITY),
        "-.inf" | "-.Inf" | "-.INF" => Some(f64::NEG_INFINITY),
        ".nan" | ".NaN" | ".NAN" => Some(f64::NAN),
        _ => None,
    }
}

fn radix_body<'a>(text: &'a str, prefix: &str, digit: fn(char) -> bool) -> Option<&'a str> {
    let body = text.strip_prefix(prefix)?;
    (!body.is_empty() && body.chars().all(digit)).then_some(body)
}

fn unsigned(text: &str) -> &str {
    text.strip_prefix(['-', '+']).unwrap_or(text)
}

fn all_digits(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_digit())
}

/// `^[-+]?[0-9]+$`
fn is_decimal(text: &str) -> bool {
    let body = unsigned(text);
    !body.is_empty() && all_digits(body)
}

/// `^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$`
fn is_plain_float(text: &str) -> bool {
    let Some((whole, fraction)) = unsigned(text).split_once('.') else { return false };
    all_digits(whole) && all_digits(fraction) && (!whole.is_empty() || !fraction.is_empty())
}

/// `^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$`
fn is_exponent_float(text: &str) -> bool {
    let Some((mantissa, exponent)) = unsigned(text).split_once(['e', 'E']) else { return false };
    let exponent = unsigned(exponent);
    if exponent.is_empty() || !all_digits(exponent) {
        return false;
    }
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    all_digits(whole) && all_digits(fraction) && (!whole.is_empty() || !fraction.is_empty())
}

/// The value a resolved plain scalar is, with an integer past 2^53 kept as
/// written when the double cannot hold it.
pub(super) fn plain_value(text: &str) -> Value {
    match resolve_plain(text) {
        Core::Null => Value::Null,
        Core::Bool(b) => Value::Bool(b),
        Core::Text => Value::String(text.to_string()),
        Core::Number { value, integer: true } => {
            super::number::written_integer(text, value).map_or(Value::Number(value), Value::BigInt)
        }
        Core::Number { value, integer: false } => Value::Number(value),
    }
}

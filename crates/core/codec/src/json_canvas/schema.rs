//! The wire schema's leaves, as Zod 4 reads them: each answers the value it
//! read and the issues it raised, and an issue says whether Zod goes on
//! checking the same value after it.
//!
//! The value is `None` exactly when an issue aborted: the checks after it do
//! not run, and a union, an object and a refinement above it treat the value
//! as unread. An issue that continues (a length, a range, a pattern) leaves
//! the value in place, which is why a document can carry one and still be
//! checked for duplicate ids.

use super::issue::Code;
use super::length;
use super::url;
use whiteboard_model::checks::canvas_color_hex;
use whiteboard_model::spatial::{CanvasColor, CanvasColorPreset};
use whiteboard_model::{Map, Value};

/// One issue, and whether Zod runs the checks after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Flaw {
    pub code: Code,
    pub continues: bool,
}

pub(super) type Flaws = Vec<Flaw>;
pub(super) type Read<T> = (Option<T>, Flaws);

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

const fn aborting(code: Code) -> Flaw {
    Flaw { code, continues: false }
}

const fn continuing(code: Code) -> Flaw {
    Flaw { code, continues: true }
}

fn refused<T>(code: Code) -> Read<T> {
    (None, vec![aborting(code)])
}

/// The value read with no issue, or `None`: what a `.catch(undefined)` keeps.
pub(super) fn silent<T>((value, flaws): Read<T>) -> Option<T> {
    if flaws.is_empty() { value } else { None }
}

/// `z.object`'s test for its input: a plain object, not an array or null.
pub(super) fn object(value: &Value) -> Option<&Map> {
    if let Value::Map(entries) = value { Some(entries) } else { None }
}

pub(super) fn get<'a>(entries: &'a Map, key: &str) -> Option<&'a Value> {
    entries.iter().find(|(held, _)| held == key).map(|(_, item)| item)
}

pub(super) fn string(value: &Value) -> Read<&str> {
    match value {
        Value::String(text) => (Some(text.as_str()), Vec::new()),
        _ => refused(Code::InvalidType),
    }
}

/// `z.string().min(1)`.
pub(super) fn node_id(value: &Value) -> Read<&str> {
    let (text, mut flaws) = string(value);
    // A value that is no string but has a length is checked as one is.
    if text.is_some_and(str::is_empty) || (text.is_none() && length::below_one(value)) {
        flaws.push(continuing(Code::TooSmall));
    }
    (text, flaws)
}

pub(super) fn number(value: &Value) -> Read<f64> {
    match value {
        Value::Number(n) if n.is_finite() => (Some(*n), Vec::new()),
        _ => refused(Code::InvalidType),
    }
}

/// `z.number().int()`: a whole number inside the safe range.
pub(super) fn int(value: &Value) -> Read<f64> {
    let (number, flaws) = number(value);
    let Some(n) = number else { return (None, flaws) };
    if n.fract() != 0.0 {
        return refused(Code::InvalidType);
    }
    if n.abs() > MAX_SAFE_INTEGER {
        let code = if n.is_sign_negative() { Code::TooSmall } else { Code::TooBig };
        return (Some(n), vec![continuing(code)]);
    }
    (Some(n), Vec::new())
}

/// `z.number().int().nonnegative()`: the second check runs after a continuing
/// first one, so a huge negative number is refused twice.
pub(super) fn size(value: &Value) -> Read<f64> {
    let (number, mut flaws) = int(value);
    if flaws.iter().any(|flaw| !flaw.continues) {
        return (number, flaws);
    }
    if number.is_some_and(|n| n < 0.0) {
        flaws.push(continuing(Code::TooSmall));
    }
    (number, flaws)
}

/// `z.enum([...])`: a string that names a variant.
pub(super) fn variant<T>(value: &Value, from_wire: fn(&str) -> Option<T>) -> Read<T> {
    match value {
        Value::String(text) => {
            from_wire(text).map_or_else(|| refused(Code::InvalidValue), |v| (Some(v), Vec::new()))
        }
        _ => refused(Code::InvalidValue),
    }
}

/// The union of the six presets and a hex string. A string that is neither
/// fails the preset arm outright and the hex arm only on its pattern, so Zod
/// reports the pattern; anything else fails both and reports the union.
pub(super) fn color(value: &Value) -> Read<CanvasColor> {
    let Value::String(text) = value else { return refused(Code::InvalidUnion) };
    if let Some(preset) = CanvasColorPreset::from_wire(text) {
        return (Some(CanvasColor::CanvasColorPreset(preset)), Vec::new());
    }
    let flaws =
        if canvas_color_hex(text) { Vec::new() } else { vec![continuing(Code::InvalidFormat)] };
    (Some(CanvasColor::CanvasColorHex(text.clone())), flaws)
}

/// `z.string().regex(/^#/)`.
pub(super) fn subpath(value: &Value) -> Read<&str> {
    let (text, mut flaws) = string(value);
    if text.is_some_and(|text| !text.starts_with('#')) {
        flaws.push(continuing(Code::InvalidFormat));
    }
    (text, flaws)
}

/// `z.url()`: the value is the trimmed text without tabs and line breaks, and
/// it is valid when the host's URL parser accepts it.
pub(super) fn link_url(value: &Value) -> Read<String> {
    let (text, mut flaws) = string(value);
    let Some(text) = text else { return (None, flaws) };
    if !url::zod_url_valid(text) {
        flaws.push(continuing(Code::InvalidFormat));
    }
    (Some(url::zod_url_value(text)), flaws)
}

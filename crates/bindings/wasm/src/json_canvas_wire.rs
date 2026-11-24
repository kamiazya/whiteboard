//! The JSON Canvas exports' canvas wire: a [`SpatialCanvas`] as JSON, and back.
//!
//! A canvas is a value: an object is `["m", key, item, ...]` in the order the
//! host enumerates it, a list `["s", item, ...]`, and `null`, a boolean and a
//! string are themselves. A number is its own JSON integer when it is a safe
//! integer other than `-0` (a canvas holds hundreds of them and their 16 hex
//! digits would be most of the wire), and `["f", hex]`, the 64 bits of the
//! double, otherwise; `["b", digits]` is a `bigint`. One array per collection,
//! so a value nested to the writer's depth stays inside `serde_json`'s
//! recursion limit.
//!
//! The canvas and the value are one another by `whiteboard-model`'s
//! [`canvas_value`] and [`canvas_of`]: written in the order the TypeScript lifts
//! a canvas in and read strictly, so a wire that is no canvas is refused as
//! malformed and the host's TypeScript answers. The value readers are
//! re-exported for the layout request's own objects, read the same way.

use serde_json::{Number, Value as Json, json};
use std::collections::BTreeSet;
use whiteboard_model::canvas_value::canvas_value;
pub(crate) use whiteboard_model::canvas_value::{
    Fields, Read, bends_of, canvas_of, color_of, edge_end_of, edge_of, facets_of, items_of,
    line_end_of, line_of, node_of, number_of, string_of,
};
use whiteboard_model::spatial::SpatialCanvas;
use whiteboard_model::{Map, Value};

/// The largest integer a double holds exactly, and the largest a wire number spells as one.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn safe_integer(n: f64) -> Option<i64> {
    let whole = n.fract() == 0.0 && n.abs() <= MAX_SAFE && !(n == 0.0 && n.is_sign_negative());
    if whole { format!("{n}").parse().ok() } else { None }
}

/// The wire of a value.
pub fn value_json(value: &Value) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Bool(b) => json!(b),
        Value::String(s) => json!(s),
        Value::Number(n) => match safe_integer(*n) {
            Some(whole) => Json::Number(Number::from(whole)),
            None => json!(["f", format!("{:016x}", n.to_bits())]),
        },
        Value::BigInt(digits) => json!(["b", digits]),
        Value::Seq(items) => {
            Json::Array(std::iter::once(json!("s")).chain(items.iter().map(value_json)).collect())
        }
        Value::Map(entries) => Json::Array(
            std::iter::once(json!("m"))
                .chain(entries.iter().flat_map(|(key, item)| [json!(key), value_json(item)]))
                .collect(),
        ),
    }
}

/// The value a wire stands for, or `None` when it is not one: an object, a
/// number that is not a safe integer, an unknown tag, a double that is not
/// sixteen hex digits, a mapping with an odd tail, a non-string key or a key
/// held twice (a host object cannot hold one).
pub fn json_value(wire: &Json) -> Option<Value> {
    Some(match wire {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::String(s) => Value::String(s.clone()),
        Json::Number(n) => Value::Number(whole_number(n)?),
        Json::Object(_) => return None,
        Json::Array(parts) => {
            let (tag, rest) = parts.split_first()?;
            match (tag.as_str()?, rest) {
                ("f", [Json::String(hex)]) => Value::Number(f64::from_bits(bits(hex)?)),
                ("b", [Json::String(digits)]) => Value::BigInt(digits.clone()),
                ("s", items) => Value::Seq(items.iter().map(json_value).collect::<Option<_>>()?),
                ("m", pairs) => Value::Map(entries(pairs)?),
                _ => return None,
            }
        }
    })
}

fn whole_number(n: &Number) -> Option<f64> {
    if !(n.is_i64() || n.is_u64()) {
        return None;
    }
    n.as_f64().filter(|whole| whole.abs() <= MAX_SAFE)
}

fn bits(hex: &str) -> Option<u64> {
    if hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        None
    }
}

fn entries(pairs: &[Json]) -> Option<Map> {
    let mut seen = BTreeSet::new();
    pairs
        .chunks(2)
        .map(|pair| {
            let [Json::String(key), item] = pair else { return None };
            seen.insert(key.as_str()).then_some(())?;
            Some((key.clone(), json_value(item)?))
        })
        .collect()
}

/// The wire of a canvas.
pub fn canvas_json(c: &SpatialCanvas) -> Json {
    value_json(&canvas_value(c))
}

/// The canvas a wire stands for, or `None` when it is no canvas.
pub fn canvas_from(wire: &Json) -> Option<SpatialCanvas> {
    canvas_of(&json_value(wire)?)
}

#[cfg(test)]
mod tests;

//! A value in the form the engine's reads answer in: plain JSON that keeps
//! what JSON drops. The TypeScript writes an answer this way so a `NaN` or a
//! one-key object named like a marker survives the wire; a value a loro
//! document holds has no `undefined`, `Set` or `Map`, so only the non-finite
//! number and the marker-named object remain to be written.

use crate::read::loro_value_to_value;
use loro::LoroValue;
use whiteboard_model::Value;

/// The names the wire reserves for a value JSON cannot carry. A one-key
/// application object named by one of them is wrapped in `$object`, so it
/// cannot be read back as the marker.
const MARKERS: [&str; 8] = [
    "$object",
    "$undefined",
    "$number",
    "$bigint",
    "$set",
    "$map",
    "$loroState",
    "$unrepresentable",
];

/// An answer the TypeScript gives and this crate does not: the caller asks it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Undecided;

/// `{ "$undefined": true }`: what the wire writes for no value.
pub(crate) fn undefined() -> Value {
    Value::Map(vec![("$undefined".to_owned(), Value::Bool(true))])
}

/// A loro value as the wire writes the value npm loro-crdt hands the reader.
///
/// `None` for a binary value: the TypeScript writes it as the state of a loro
/// document imported from its bytes, which no writer of the document model
/// stores, so a document holding one is not answered here at all.
pub(crate) fn plain(value: &LoroValue) -> Option<Value> {
    Some(match value {
        LoroValue::Null => Value::Null,
        LoroValue::Bool(b) => Value::Bool(*b),
        LoroValue::Double(d) => number(*d),
        LoroValue::I64(_) => loro_value_to_value(value),
        LoroValue::String(s) => Value::String(s.to_string()),
        LoroValue::List(items) => {
            Value::Seq(items.iter().map(plain).collect::<Option<Vec<Value>>>()?)
        }
        LoroValue::Map(entries) => plain_object(entries.iter())?,
        LoroValue::Binary(_) | LoroValue::Container(_) => return None,
    })
}

/// An object's entries written plain, keys ascending, and wrapped when the one
/// key it has is a marker's name.
pub(crate) fn plain_object<'a>(
    entries: impl Iterator<Item = (&'a String, &'a LoroValue)>,
) -> Option<Value> {
    let written = entries
        .map(|(k, v)| Some((k.clone(), plain(v)?)))
        .collect::<Option<Vec<(String, Value)>>>()?;
    Some(object_of(written))
}

/// An object as the wire writes it: keys ascending, and wrapped when the one
/// key it has is a marker's name.
pub(crate) fn object_of(mut written: Vec<(String, Value)>) -> Value {
    written.sort_by(|a, b| a.0.cmp(&b.0));
    match written.as_slice() {
        [(only, _)] if MARKERS.contains(&only.as_str()) => {
            Value::Map(vec![("$object".to_owned(), Value::Map(written))])
        }
        _ => Value::Map(written),
    }
}

fn number(d: f64) -> Value {
    if d.is_finite() {
        Value::Number(d)
    } else {
        let text = if d.is_nan() {
            "NaN"
        } else if d.is_sign_positive() {
            "Infinity"
        } else {
            "-Infinity"
        };
        Value::Map(vec![("$number".to_owned(), Value::String(text.to_owned()))])
    }
}

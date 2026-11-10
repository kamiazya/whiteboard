//! The recording's encoding of a value, read by the tests that replay it or draw from it. A value is `null`, a
//! boolean, a string, an array, a JSON integer or `{"f":hex}` for the bits of
//! any other number, and `{"m":[[key,value],...]}` for a mapping in the order
//! JavaScript enumerates its keys. An issue is `[path, code, detail]`.

use serde_json::Value as Json;
use whiteboard_model::Value;

/// The value a recording's encoding stands for, or `None` for anything the
/// recording never writes.
pub(crate) fn decode(json: &Json) -> Option<Value> {
    Some(match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::String(s) => Value::String(s.clone()),
        Json::Number(n) => Value::Number(n.as_f64()?),
        Json::Array(items) => Value::Seq(items.iter().map(decode).collect::<Option<_>>()?),
        Json::Object(object) => {
            if let Some(bits) = object.get("f").and_then(Json::as_str) {
                return Some(Value::Number(f64::from_bits(u64::from_str_radix(bits, 16).ok()?)));
            }
            let pairs = object.get("m")?.as_array()?;
            let entry = |pair: &Json| {
                let pair = pair.as_array()?;
                Some((pair.first()?.as_str()?.to_owned(), decode(pair.get(1)?)?))
            };
            Value::Map(pairs.iter().map(entry).collect::<Option<_>>()?)
        }
    })
}

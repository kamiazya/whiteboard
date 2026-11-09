//! The recording's encoding of a frontmatter value, shared by the two oracle
//! tests. A value is `null`, a boolean, a string, an array, `{"f":hex}` for
//! the bits of a number, `{"big":digits}` or `{"m":[[key,value],...]}` for a
//! mapping in the order JavaScript enumerates its keys. A string JSON cannot
//! spell (a lone surrogate) is `{"u":[units]}`, which a Rust `String` cannot
//! hold, so [`decode`] answers `None` for it.

use serde_json::{Value as Json, json};
use whiteboard_codec::frontmatter::Value;

/// The index JavaScript gives an array-index key, or `None`.
fn array_index(key: &str) -> Option<u32> {
    let canonical = key == "0" || (!key.starts_with('0') && !key.is_empty());
    if !canonical || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

/// The recording's encoding of a value, with a mapping's keys in the order
/// JavaScript enumerates them: array indices ascending, then the rest as written.
pub(crate) fn encode(value: &Value) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Bool(b) => json!(b),
        Value::Number(n) => json!({"f": format!("{:016x}", n.to_bits())}),
        Value::BigInt(digits) => json!({"big": digits}),
        Value::String(s) => json!(s),
        Value::Seq(items) => Json::Array(items.iter().map(encode).collect()),
        Value::Map(entries) => {
            let mut indexed: Vec<_> =
                entries.iter().filter_map(|(k, v)| Some((array_index(k)?, k, v))).collect();
            indexed.sort_by_key(|entry| entry.0);
            let rest = entries.iter().filter(|(k, _)| array_index(k).is_none());
            let ordered =
                indexed.into_iter().map(|(_, k, v)| (k, v)).chain(rest.map(|(k, v)| (k, v)));
            json!({"m": ordered.map(|(k, v)| json!([k, encode(v)])).collect::<Vec<_>>()})
        }
    }
}

/// The value a recording's encoding stands for, or `None` when it holds a
/// string no Rust `String` can.
pub(crate) fn decode(json: &Json) -> Option<Value> {
    Some(match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::String(s) => Value::String(s.clone()),
        Json::Array(items) => Value::Seq(items.iter().map(decode).collect::<Option<_>>()?),
        Json::Object(object) => {
            if object.contains_key("u") {
                return None;
            }
            if let Some(bits) = object.get("f").and_then(Json::as_str) {
                let bits = u64::from_str_radix(bits, 16);
                assert!(bits.is_ok(), "{object:?} holds no 64 bits");
                return Some(Value::Number(f64::from_bits(bits.unwrap_or_default())));
            }
            if let Some(digits) = object.get("big").and_then(Json::as_str) {
                return Some(Value::BigInt(digits.to_string()));
            }
            let pairs = object.get("m").and_then(Json::as_array);
            assert!(pairs.is_some(), "{object:?} is no recorded value");
            let pairs = pairs.map_or(&[][..], Vec::as_slice);
            Value::Map(
                pairs
                    .iter()
                    .map(|p| Some((p[0].as_str()?.to_string(), decode(&p[1])?)))
                    .collect::<Option<_>>()?,
            )
        }
        Json::Number(_) => unreachable!("the recording encodes numbers as bits"),
    })
}

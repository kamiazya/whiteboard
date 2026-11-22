//! What the recordings' tests share: the base64 the bytes are recorded in and
//! the comparison of a recorded JSON value with a model value.

use serde_json::Value as Json;
use whiteboard_model::Value;

pub(crate) fn rows_of(recording: &str) -> Vec<Json> {
    recording
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str::<Json>(line).expect("a recorded line"))
        .collect()
}

pub(crate) fn base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut bits: u32 = 0;
    let mut held = 0_u32;
    for byte in text.bytes().filter(|b| *b != b'=') {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            other => panic!("not base64: {other}"),
        };
        bits = (bits << 6) | u32::from(sextet);
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push(u8::try_from((bits >> held) & 0xff).expect("a byte"));
        }
    }
    out
}

/// A recorded JSON value as the model's, a mapping's keys sorted: the key
/// order of a deep value is not part of it.
pub(crate) fn model_of(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Number(n.as_f64().expect("a double")),
        Json::String(s) => Value::String(s.clone()),
        Json::Array(items) => Value::Seq(items.iter().map(model_of).collect()),
        Json::Object(entries) => {
            let mut map: Vec<(String, Value)> =
                entries.iter().map(|(k, v)| (k.clone(), model_of(v))).collect();
            map.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Map(map)
        }
    }
}

/// `[[peer, counter], ...]` as the pairs the crate answers.
pub(crate) fn pairs_of(json: &Json) -> Vec<(String, i64)> {
    json.as_array()
        .expect("pairs")
        .iter()
        .map(|pair| {
            (pair[0].as_str().expect("a peer").to_owned(), pair[1].as_i64().expect("a counter"))
        })
        .collect()
}

/// Where two model values first differ, as a path and the two sides, cut to a
/// readable length; `None` when they are equal. A deep value is large, and an
/// assertion on whole values buries the one place that moved.
pub(crate) fn first_difference(path: &str, left: &Value, right: &Value) -> Option<String> {
    let cut = |v: &Value| format!("{v:?}").chars().take(160).collect::<String>();
    match (left, right) {
        (Value::Map(lm), Value::Map(rm)) => {
            for (k, v) in lm {
                let at = format!("{path}/{k}");
                match rm.iter().find(|(key, _)| key == k) {
                    Some((_, other)) => {
                        if let Some(found) = first_difference(&at, v, other) {
                            return Some(found);
                        }
                    }
                    None => return Some(format!("{at}: only in the left: {}", cut(v))),
                }
            }
            rm.iter()
                .find(|(k, _)| !lm.iter().any(|(key, _)| key == k))
                .map(|(k, other)| format!("{path}/{k}: only in the right: {}", cut(other)))
        }
        (Value::Seq(ls), Value::Seq(rs)) if ls.len() == rs.len() => ls
            .iter()
            .zip(rs)
            .enumerate()
            .find_map(|(i, (v, other))| first_difference(&format!("{path}[{i}]"), v, other)),
        _ if left == right => None,
        _ => Some(format!("{path}: {} != {}", cut(left), cut(right))),
    }
}

/// Fails with the first difference of two values, naming `what`.
pub(crate) fn assert_same(what: &str, actual: &Value, recorded: &Value) {
    if let Some(found) = first_difference("", actual, recorded) {
        panic!("{what}: {found}");
    }
}

/// A value without its `__proto__` map keys, and whether it held any. A
/// JavaScript object cannot hold that key as data (assigning it sets the
/// prototype), so the TypeScript's `toJSON` never shows it while the loro
/// document does hold it; a Rust map has no such quirk.
pub(crate) fn without_proto(value: &Value) -> (Value, bool) {
    match value {
        Value::Map(entries) => {
            let mut dropped = false;
            let mut kept = Vec::with_capacity(entries.len());
            for (k, v) in entries {
                if k == "__proto__" {
                    dropped = true;
                    continue;
                }
                let (inner, had) = without_proto(v);
                dropped |= had;
                kept.push((k.clone(), inner));
            }
            (Value::Map(kept), dropped)
        }
        Value::Seq(items) => {
            let mut dropped = false;
            let kept = items
                .iter()
                .map(|v| {
                    let (inner, had) = without_proto(v);
                    dropped |= had;
                    inner
                })
                .collect();
            (Value::Seq(kept), dropped)
        }
        other => (other.clone(), false),
    }
}

//! A contract or manifest file read as the `Value` the interpreter reads.

use serde_json::Value as Json;
use whiteboard_model::Value;

/// A contract or manifest file as the `Value` the interpreter reads.
pub(crate) fn from_json(text: &str) -> Option<Value> {
    fn convert(json: &Json) -> Option<Value> {
        Some(match json {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::String(s) => Value::String(s.clone()),
            Json::Number(n) => Value::Number(n.as_f64()?),
            Json::Array(items) => Value::Seq(items.iter().map(convert).collect::<Option<_>>()?),
            Json::Object(object) => Value::Map(
                object
                    .iter()
                    .map(|(k, v)| Some((k.clone(), convert(v)?)))
                    .collect::<Option<_>>()?,
            ),
        })
    }
    convert(&serde_json::from_str(text).ok()?)
}

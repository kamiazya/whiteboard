//! A recorded facet bucket, written as plain JSON, read into the model's bucket
//! for the plugin's readers to read.

use serde_json::Value as Json;
use whiteboard_model::Value;
use whiteboard_model::spatial::ExtensionFacets;

fn value_of(json: &Json) -> Value {
    match json {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => Value::Number(n.as_f64().unwrap_or(f64::NAN)),
        Json::String(s) => Value::String(s.clone()),
        Json::Array(items) => Value::Seq(items.iter().map(value_of).collect()),
        Json::Object(entries) => {
            Value::Map(entries.iter().map(|(k, v)| (k.clone(), value_of(v))).collect())
        }
    }
}

/// The bucket a recorded `facets` object holds; none when the record has none.
pub(crate) fn facets_of(json: Option<&Json>) -> Option<ExtensionFacets> {
    match value_of(json?) {
        Value::Map(entries) => Some(entries),
        _ => None,
    }
}

//! A tool's output as one tree, written two ways: as the value a result's
//! `structuredContent` carries, and as `JSON.stringify` writes it into the
//! text content. A `serde_json` map sorts its keys, so the text is written
//! from the tree, in the order the TypeScript builds its object.

use serde_json::{Map, Value};

/// A JSON value whose objects keep their members in the order written.
pub(crate) enum Json {
    Text(String),
    Bool(bool),
    List(Vec<Json>),
    Object(Vec<(&'static str, Json)>),
}

impl Json {
    /// The value, as `structuredContent` carries it.
    pub(crate) fn value(&self) -> Value {
        match self {
            Self::Text(text) => Value::from(text.as_str()),
            Self::Bool(flag) => Value::Bool(*flag),
            Self::List(items) => Value::Array(items.iter().map(Self::value).collect()),
            Self::Object(members) => Value::Object(
                members
                    .iter()
                    .map(|(key, value)| ((*key).to_owned(), value.value()))
                    .collect::<Map<_, _>>(),
            ),
        }
    }

    /// `JSON.stringify` of the value; a string is escaped as it escapes a
    /// well-formed one, which is how `serde_json` escapes it too.
    pub(crate) fn text(&self) -> String {
        match self {
            Self::Text(text) => Value::from(text.as_str()).to_string(),
            Self::Bool(flag) => flag.to_string(),
            Self::List(items) => {
                let items: Vec<String> = items.iter().map(Self::text).collect();
                format!("[{}]", items.join(","))
            }
            Self::Object(members) => {
                let members: Vec<String> = members
                    .iter()
                    .map(|(key, value)| format!("{}:{}", Value::from(*key), value.text()))
                    .collect();
                format!("{{{}}}", members.join(","))
            }
        }
    }
}

//! A tool's output as one tree, written two ways: as the value a result's
//! `structuredContent` carries, and as `JSON.stringify` writes it into the
//! text content. A `serde_json` map sorts its keys, so the text is written
//! from the tree, in the order the TypeScript builds its object.

use serde_json::{Map, Value};
use whiteboard_codec::json_canvas::json_text;
use whiteboard_model::Value as Plain;

/// A JSON value whose objects keep their members in the order written.
pub(crate) enum Json {
    Text(String),
    Bool(bool),
    /// A finite double, written as `JSON.stringify` writes it.
    Number(f64),
    List(Vec<Json>),
    Object(Vec<(&'static str, Json)>),
    /// An object whose member names are data, not the tool's own.
    Fields(Vec<(String, Json)>),
    /// A value an operation answers as it was read, objects in their stored
    /// order.
    Plain(Plain),
}

impl Json {
    /// The value, as `structuredContent` carries it.
    pub(crate) fn value(&self) -> Value {
        match self {
            Self::Text(text) => Value::from(text.as_str()),
            Self::Bool(flag) => Value::Bool(*flag),
            Self::Number(number) => number_value(*number),
            Self::List(items) => Value::Array(items.iter().map(Self::value).collect()),
            Self::Object(members) => Value::Object(
                members
                    .iter()
                    .map(|(key, value)| ((*key).to_owned(), value.value()))
                    .collect::<Map<_, _>>(),
            ),
            Self::Fields(members) => Value::Object(
                members.iter().map(|(key, value)| (key.clone(), value.value())).collect(),
            ),
            // What `JSON.parse` of its text reads back, which is what a
            // client of the TypeScript reads: a whole double past 2^53 an
            // integer, a number JSON cannot spell `null`.
            Self::Plain(_) => serde_json::from_str(&self.text()).unwrap_or(Value::Null),
        }
    }

    /// `JSON.stringify` of the value; a string is escaped as it escapes a
    /// well-formed one, which is how `serde_json` escapes it too.
    pub(crate) fn text(&self) -> String {
        match self {
            Self::Text(text) => Value::from(text.as_str()).to_string(),
            Self::Bool(flag) => flag.to_string(),
            Self::Number(number) => json_text(&Plain::Number(*number)).unwrap_or_default(),
            Self::List(items) => {
                let items: Vec<String> = items.iter().map(Self::text).collect();
                format!("[{}]", items.join(","))
            }
            Self::Object(members) => object_text(members.iter().map(|(key, value)| (*key, value))),
            Self::Fields(members) => {
                object_text(members.iter().map(|(key, value)| (key.as_str(), value)))
            }
            // An operation's value is plain JSON, which the writer always
            // spells.
            Self::Plain(plain) => json_text(plain).unwrap_or_default(),
        }
    }
}

/// The number its text reads back as: a whole double within the safe range
/// as the integer `JSON.parse` of its digits gives, any other as the double
/// itself (exact, where a parser of its text may land an ulp off).
fn number_value(number: f64) -> Value {
    const SAFE: f64 = 9_007_199_254_740_991.0;
    if number.fract() == 0.0 && number.abs() <= SAFE {
        let whole = format!("{}", number.abs());
        let digits: u64 = whole.parse().unwrap_or_default();
        return if number < 0.0 {
            Value::from(0_i64.saturating_sub_unsigned(digits))
        } else {
            Value::from(digits)
        };
    }
    serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
}

/// `JSON.stringify` of an object's members, in the order given.
fn object_text<'a>(members: impl Iterator<Item = (&'a str, &'a Json)>) -> String {
    let members: Vec<String> =
        members.map(|(key, value)| format!("{}:{}", Value::from(key), value.text())).collect();
    format!("{{{}}}", members.join(","))
}

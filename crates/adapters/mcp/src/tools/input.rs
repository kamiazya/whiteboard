//! A tool's arguments judged as the SDK judges them against the tool's Zod
//! input schema, and refused in its words: `Input validation error: Invalid
//! arguments for tool <name>: ` and then each issue as `<path>: <message>`
//! (the message alone at the root), joined by `, `.
//!
//! The JSON Schema a contract publishes cannot say this: a refinement's
//! message is Zod's and is not in it. So a tool declares its input here, as
//! the strict object its Zod schema is, and the recording holds the two equal.

use serde_json::{Map, Value};

use crate::schema::received;

/// A strict object: each field as its kind requires, and any other key refused.
pub(crate) struct Input {
    pub(crate) fields: &'static [Field],
}

/// A member and what it must be.
pub(crate) struct Field {
    pub(crate) name: &'static str,
    pub(crate) kind: Kind,
}

/// The member kinds the bound tools' schemas use.
pub(crate) enum Kind {
    /// A required string, refined.
    Text(Refined),
    /// A required array of refined strings, `min` to `max` items long.
    List { min: usize, max: usize, item: Refined },
    /// An optional strict object.
    Object(&'static [Field]),
    /// An optional boolean.
    Flag,
}

/// A string held to `test`, refused with `message` when it fails.
pub(crate) struct Refined {
    pub(crate) test: fn(&str) -> bool,
    pub(crate) message: &'static str,
}

/// The SDK's refusal of `arguments` for the tool `tool`, if it refuses them.
pub(crate) fn refusal(tool: &str, input: &Input, arguments: &Map<String, Value>) -> Option<String> {
    let issues = object_issues("", input.fields, arguments);
    (!issues.is_empty()).then(|| {
        format!("Input validation error: Invalid arguments for tool {tool}: {}", issues.join(", "))
    })
}

/// `<path>: <message>`, or the message alone at the root.
fn at(path: &str, message: &str) -> String {
    if path.is_empty() { message.to_owned() } else { format!("{path}: {message}") }
}

fn joined(path: &str, name: &str) -> String {
    if path.is_empty() { name.to_owned() } else { format!("{path}.{name}") }
}

fn expected(path: &str, kind: &str, value: Option<&Value>) -> String {
    at(path, &format!("Invalid input: expected {kind}, received {}", received(value)))
}

/// Each field's issues in the schema's order, then the keys it does not name.
/// Zod names those in the order the client wrote them; a `serde_json` map has
/// sorted them already.
fn object_issues(path: &str, fields: &[Field], object: &Map<String, Value>) -> Vec<String> {
    let mut issues: Vec<String> = fields
        .iter()
        .flat_map(|field| {
            field_issues(&joined(path, field.name), &field.kind, object.get(field.name))
        })
        .collect();
    let unknown: Vec<String> = object
        .keys()
        .filter(|key| !fields.iter().any(|field| field.name == key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    if !unknown.is_empty() {
        let plural = if unknown.len() > 1 { "s" } else { "" };
        issues.push(at(path, &format!("Unrecognized key{plural}: {}", unknown.join(", "))));
    }
    issues
}

fn field_issues(path: &str, kind: &Kind, value: Option<&Value>) -> Vec<String> {
    match kind {
        Kind::Text(refined) => text_issue(path, refined, value).into_iter().collect(),
        Kind::List { min, max, item } => list_issues(path, (*min, *max), item, value),
        Kind::Object(fields) => match value {
            None => Vec::new(),
            Some(Value::Object(object)) => object_issues(path, fields, object),
            Some(_) => vec![expected(path, "object", value)],
        },
        Kind::Flag => match value {
            None | Some(Value::Bool(_)) => Vec::new(),
            Some(_) => vec![expected(path, "boolean", value)],
        },
    }
}

fn text_issue(path: &str, refined: &Refined, value: Option<&Value>) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(text) if (refined.test)(text) => None,
        Some(_) => Some(at(path, refined.message)),
        None => Some(expected(path, "string", value)),
    }
}

/// An array's length out of bounds is its only issue; within them, each
/// item's. A string is no array, and Zod still judges its length, in
/// characters (UTF-16 code units).
fn list_issues(
    path: &str,
    (min, max): (usize, usize),
    item: &Refined,
    value: Option<&Value>,
) -> Vec<String> {
    let bounds = |length: usize, what: &str| {
        if length < min {
            Some(at(path, &format!("Too small: expected {what} to have >={min} {}", unit(what))))
        } else if length > max {
            Some(at(path, &format!("Too big: expected {what} to have <={max} {}", unit(what))))
        } else {
            None
        }
    };
    match value {
        Some(Value::Array(items)) => bounds(items.len(), "array").map_or_else(
            || {
                items
                    .iter()
                    .enumerate()
                    .filter_map(|(at, held)| {
                        text_issue(&joined(path, &at.to_string()), item, Some(held))
                    })
                    .collect()
            },
            |issue| vec![issue],
        ),
        Some(Value::String(text)) => std::iter::once(expected(path, "array", value))
            .chain(bounds(text.encode_utf16().count(), "string"))
            .collect(),
        _ => vec![expected(path, "array", value)],
    }
}

fn unit(what: &str) -> &'static str {
    if what == "array" { "items" } else { "characters" }
}

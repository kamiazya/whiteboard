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
    /// An optional string, any string.
    OptionalText,
    /// An optional string, one of these.
    Choice(&'static [&'static str]),
    /// An optional non-empty string of at most `max` UTF-16 units, refused
    /// past it with `too_big`.
    Bounded { max: usize, too_big: &'static str },
    /// An optional array of refined strings, `min` to `max` items long,
    /// refused past `max` with `too_big`.
    Listed { min: usize, max: usize, too_big: &'static str, item: Refined },
    /// An optional integer from `min` to `max` (whole numbers, which
    /// `Display` writes as Zod does).
    Whole { min: f64, max: f64 },
}

/// `Number.MAX_SAFE_INTEGER`, which Zod's `int()` holds a number to.
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

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
        Kind::List { min, max, item } => list_issues(path, (*min, *max), None, item, value),
        Kind::Listed { min, max, too_big, item } => match value {
            None => Vec::new(),
            Some(_) => list_issues(path, (*min, *max), Some(too_big), item, value),
        },
        Kind::Bounded { max, too_big } => {
            bounded_issue(path, *max, too_big, value).into_iter().collect()
        }
        Kind::Whole { min, max } => whole_issues(path, (*min, *max), value),
        Kind::Object(fields) => match value {
            None => Vec::new(),
            Some(Value::Object(object)) => object_issues(path, fields, object),
            Some(_) => vec![expected(path, "object", value)],
        },
        Kind::Flag => match value {
            None | Some(Value::Bool(_)) => Vec::new(),
            Some(_) => vec![expected(path, "boolean", value)],
        },
        Kind::OptionalText => match value {
            None | Some(Value::String(_)) => Vec::new(),
            Some(_) => vec![expected(path, "string", value)],
        },
        Kind::Choice(options) => match value {
            None => Vec::new(),
            Some(Value::String(text)) if options.contains(&text.as_str()) => Vec::new(),
            // Zod's enum names its options whatever was given, a non-string
            // and `null` included.
            Some(_) => {
                let options: Vec<String> = options.iter().map(|o| format!("\"{o}\"")).collect();
                vec![at(path, &format!("Invalid option: expected one of {}", options.join("|")))]
            }
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

/// An optional string of one unit to `max`: `too_big` past it, Zod's own
/// words under it.
fn bounded_issue(path: &str, max: usize, too_big: &str, value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let units = text.encode_utf16().count();
            if units < 1 {
                Some(at(path, "Too small: expected string to have >=1 characters"))
            } else if units > max {
                Some(at(path, too_big))
            } else {
                None
            }
        }
        _ => Some(expected(path, "string", value)),
    }
}

/// An integer's issues as Zod's `number().int().min().max()` judges one: a
/// fraction is the only issue, while an integer past the safe range is one
/// and the bounds are judged on beside it.
fn whole_issues(path: &str, (min, max): (f64, f64), value: Option<&Value>) -> Vec<String> {
    let Some(given) = value else { return Vec::new() };
    let Some(number) = given.as_f64() else { return vec![expected(path, "number", value)] };
    if number.fract() != 0.0 {
        return vec![expected(path, "int", Some(given))];
    }
    let mut issues = Vec::new();
    if number > SAFE_INTEGER {
        issues.push(at(path, "Too big: expected int to be <=9007199254740991"));
    } else if number < -SAFE_INTEGER {
        issues.push(at(path, "Too small: expected int to be >=-9007199254740991"));
    }
    if number < min {
        issues.push(at(path, &format!("Too small: expected number to be >={min}")));
    }
    if number > max {
        issues.push(at(path, &format!("Too big: expected number to be <={max}")));
    }
    issues
}

/// An array's length out of bounds is its only issue; within them, each
/// item's. A string is no array, and Zod still judges its length, in
/// characters (UTF-16 code units). Past `max`, `too_big` replaces Zod's
/// words when the schema gave its own.
fn list_issues(
    path: &str,
    (min, max): (usize, usize),
    too_big: Option<&str>,
    item: &Refined,
    value: Option<&Value>,
) -> Vec<String> {
    let bounds = |length: usize, what: &str| {
        if length < min {
            Some(at(path, &format!("Too small: expected {what} to have >={min} {}", unit(what))))
        } else if length > max {
            Some(at(
                path,
                &too_big.map_or_else(
                    || format!("Too big: expected {what} to have <={max} {}", unit(what)),
                    str::to_owned,
                ),
            ))
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

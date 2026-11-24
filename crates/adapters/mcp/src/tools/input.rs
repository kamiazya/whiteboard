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
    /// The schema's `superRefine` over the whole object: the message of the
    /// one issue it raises, if any. Zod judges it only when no issue so far
    /// aborted the parse ([`aborts`]), and names it after every field's.
    pub(crate) refine: Option<Refinement>,
}

/// A refinement over the whole object: the message of its issue, if any.
pub(crate) type Refinement = fn(&Map<String, Value>) -> Option<&'static str>;

/// A member and what it must be.
pub(crate) struct Field {
    pub(crate) name: &'static str,
    pub(crate) kind: Kind,
}

/// The member kinds the bound tools' schemas use.
pub(crate) enum Kind {
    /// A required string, refined.
    Text(Refined),
    /// A required string `min` to `max` characters long, then at most `max`
    /// UTF-16 units: `utf16Max(z.string().min(min), max)`, whose refinement
    /// is judged only when the length in characters passed.
    Sized { min: usize, max: usize },
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
    /// The same string, required.
    RequiredBounded { max: usize, too_big: &'static str },
    /// An optional document path: `utf16Max(z.string().min(1), max)` refined
    /// by `segments`, which Zod judges whatever the length checks said.
    Path { max: usize, segments: Refined },
    /// An optional array of refined strings, `min` to `max` items long,
    /// refused past `max` with `too_big` where the schema gave its own words.
    Listed { min: usize, max: usize, too_big: Option<&'static str>, item: Refined },
    /// An optional integer from `min` to `max` (whole numbers, which
    /// `Display` writes as Zod does).
    Whole { min: f64, max: f64 },
    /// An optional number from `min` to `max` (an infinite bound: none),
    /// bounds `Display` writes as Zod does. JSON spells no number that is
    /// not finite, so `finite()` refuses nothing a call can carry.
    Real { min: f64, max: f64 },
    /// A member whose schema the kinds above do not express (a nested
    /// refinement, a string held to a grammar), judged by the tool's own
    /// functions.
    Checked(Checked),
}

/// A member judged by the tool's own functions.
pub(crate) struct Checked {
    /// The member's issues at `path`, as the SDK words them.
    pub(crate) issues: fn(&str, Option<&Value>) -> Vec<String>,
    /// Whether a value of the member's stops Zod judging a refinement over
    /// the object holding it ([`aborts`]); none for a member no refinement
    /// of the object holding it reads.
    pub(crate) aborts: Option<fn(Option<&Value>) -> bool>,
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
    let mut issues = object_issues("", input.fields, arguments);
    let aborted = input.fields.iter().any(|field| aborts(&field.kind, arguments.get(field.name)));
    if let Some(refine) = input.refine
        && !aborted
        && let Some(message) = refine(arguments)
    {
        issues.push(message.to_owned());
    }
    (!issues.is_empty()).then(|| {
        format!("Input validation error: Invalid arguments for tool {tool}: {}", issues.join(", "))
    })
}

/// `<path>: <message>`, or the message alone at the root.
pub(crate) fn at(path: &str, message: &str) -> String {
    if path.is_empty() { message.to_owned() } else { format!("{path}: {message}") }
}

pub(crate) fn joined(path: &str, name: &str) -> String {
    if path.is_empty() { name.to_owned() } else { format!("{path}.{name}") }
}

pub(crate) fn expected(path: &str, kind: &str, value: Option<&Value>) -> String {
    at(path, &format!("Invalid input: expected {kind}, received {}", received(value)))
}

/// Each field's issues in the schema's order, then the keys it does not name.
/// Zod names those in the order the client wrote them; a `serde_json` map has
/// sorted them already.
pub(crate) fn object_issues(
    path: &str,
    fields: &[Field],
    object: &Map<String, Value>,
) -> Vec<String> {
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
        Kind::Sized { min, max } => sized_issues(path, (*min, *max), value),
        Kind::Listed { min, max, too_big, item } => match value {
            None => Vec::new(),
            Some(_) => list_issues(path, (*min, *max), *too_big, item, value),
        },
        Kind::Bounded { max, too_big } => bounded_issues(path, *max, too_big, value),
        Kind::RequiredBounded { max, too_big } => match value {
            None => vec![expected(path, "string", None)],
            Some(_) => bounded_issues(path, *max, too_big, value),
        },
        Kind::Path { max, segments } => path_issues(path, *max, segments, value),
        Kind::Whole { min, max } => whole_issues(path, (*min, *max), value),
        Kind::Real { min, max } => real_issues(path, (*min, *max), value),
        Kind::Checked(checked) => (checked.issues)(path, value),
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

/// A length out of `min..=max` in `what`'s words, as Zod's length checks
/// word it; Zod judges the length of any value that has one.
/// Past `max`, `too_big` replaces Zod's words when the schema gave its own.
pub(crate) fn length_issue(
    path: &str,
    (min, max): (usize, usize),
    length: usize,
    what: &str,
    too_big: Option<&str>,
) -> Option<String> {
    let unit = if what == "array" { "items" } else { "characters" };
    if length < min {
        Some(at(path, &format!("Too small: expected {what} to have >={min} {unit}")))
    } else if length > max {
        Some(at(
            path,
            &too_big.map_or_else(
                || format!("Too big: expected {what} to have <={max} {unit}"),
                str::to_owned,
            ),
        ))
    } else {
        None
    }
}

/// A string's length in characters, as Zod 4 counts one: code points.
pub(crate) fn characters(text: &str) -> usize {
    text.chars().count()
}

/// A string within its bounds in characters, then within `max` UTF-16 units;
/// an array is no string, and Zod still judges its length, in items.
fn sized_issues(path: &str, (min, max): (usize, usize), value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text)) => {
            let units = text.encode_utf16().count();
            length_issue(path, (min, max), characters(text), "string", None)
                .or_else(|| {
                    (units > max).then(|| {
                        at(path, &format!("Too big: expected string to have <={max} UTF-16 units"))
                    })
                })
                .into_iter()
                .collect()
        }
        Some(Value::Array(items)) => std::iter::once(expected(path, "string", value))
            .chain(length_issue(path, (min, max), items.len(), "array", None))
            .collect(),
        _ => vec![expected(path, "string", value)],
    }
}

/// An optional document path: its length as `sized_issues` judges it, then
/// its segments, which Zod judges after a length issue too, since neither
/// aborts; a value that is no string is judged for its length alone.
fn path_issues(path: &str, max: usize, segments: &Refined, value: Option<&Value>) -> Vec<String> {
    let Some(given) = value else { return Vec::new() };
    let mut issues = sized_issues(path, (1, max), Some(given));
    if let Value::String(text) = given
        && !(segments.test)(text)
    {
        issues.push(at(path, segments.message));
    }
    issues
}

/// An optional string of one character to `max`, then at most `max` UTF-16
/// units, refused past either with `too_big`: `utf16Max(z.string().min(1),
/// max, too_big)`, whose words are the schema's for both. An array is no
/// string, and Zod still judges its length, in items.
pub(crate) fn bounded_issues(
    path: &str,
    max: usize,
    too_big: &str,
    value: Option<&Value>,
) -> Vec<String> {
    let Some(given) = value else { return Vec::new() };
    match given {
        Value::String(text) => {
            length_issue(path, (1, max), characters(text), "string", Some(too_big))
                .or_else(|| (text.encode_utf16().count() > max).then(|| at(path, too_big)))
                .into_iter()
                .collect()
        }
        Value::Array(items) => std::iter::once(expected(path, "string", value))
            .chain(length_issue(path, (1, max), items.len(), "array", Some(too_big)))
            .collect(),
        _ => vec![expected(path, "string", value)],
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

/// A number's issues as Zod's `number().min().max()` judges one: below or
/// above a bound, never both.
fn real_issues(path: &str, (min, max): (f64, f64), value: Option<&Value>) -> Vec<String> {
    let Some(given) = value else { return Vec::new() };
    let Some(number) = given.as_f64() else { return vec![expected(path, "number", value)] };
    if number < min {
        vec![at(path, &format!("Too small: expected number to be >={min}"))]
    } else if number > max {
        vec![at(path, &format!("Too big: expected number to be <={max}"))]
    } else {
        Vec::new()
    }
}

/// Whether the field's issue stops Zod judging the object's refinement: a
/// value of the wrong type (a missing required one included, and an option
/// it does not list), or an array past its maximum, which Zod judges before
/// any item. A bound on a number or a string's length, a refined string and
/// an unknown key let it run.
pub(crate) fn aborts(kind: &Kind, value: Option<&Value>) -> bool {
    let not_text = |value: &Value| !value.is_string();
    match (kind, value) {
        (Kind::Checked(checked), value) => checked.aborts.is_some_and(|aborts| aborts(value)),
        (
            Kind::Text(_) | Kind::Sized { .. } | Kind::RequiredBounded { .. } | Kind::List { .. },
            None,
        ) => true,
        (_, None) => false,
        (
            Kind::Text(_)
            | Kind::Sized { .. }
            | Kind::OptionalText
            | Kind::Bounded { .. }
            | Kind::RequiredBounded { .. }
            | Kind::Path { .. },
            Some(v),
        ) => not_text(v),
        (Kind::List { max, .. } | Kind::Listed { max, .. }, Some(v)) => {
            v.as_array().is_none_or(|items| items.len() > *max || items.iter().any(not_text))
        }
        (Kind::Choice(options), Some(v)) => !v.as_str().is_some_and(|o| options.contains(&o)),
        (Kind::Flag, Some(v)) => !v.is_boolean(),
        (Kind::Whole { .. } | Kind::Real { .. }, Some(v)) => !v.is_number(),
        (Kind::Object(fields), Some(Value::Object(object))) => {
            fields.iter().any(|field| aborts(&field.kind, object.get(field.name)))
        }
        (Kind::Object(_), Some(_)) => true,
    }
}

/// An array's length out of bounds is its only issue; within them, each
/// item's. A string is no array, and Zod still judges its length, in
/// characters (code points).
fn list_issues(
    path: &str,
    (min, max): (usize, usize),
    too_big: Option<&str>,
    item: &Refined,
    value: Option<&Value>,
) -> Vec<String> {
    let bounds = |length: usize, what: &str| length_issue(path, (min, max), length, what, too_big);
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
            .chain(bounds(characters(text), "string"))
            .collect(),
        _ => vec![expected(path, "array", value)],
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    use super::{Field, Input, Kind, refusal};

    const FIELDS: &[Field] = &[
        Field { name: "f", kind: Kind::Flag },
        Field { name: "o", kind: Kind::Object(&[Field { name: "g", kind: Kind::Flag }]) },
    ];
    const REFINED: Input = Input { fields: FIELDS, refine: Some(|_| Some("REFINED")) };

    fn issues(arguments: &Value) -> String {
        let arguments: &Map<String, Value> = arguments.as_object().expect("an object");
        let text = refusal("t", &REFINED, arguments).expect("a refusal");
        text.trim_start_matches("Input validation error: Invalid arguments for tool t: ").to_owned()
    }

    /// Zod 4's answers to `z.object({ f: z.boolean().optional(), o:
    /// z.object({ g: z.boolean().optional() }).strict().optional() }).strict()`
    /// refined by an issue `REFINED` on every value: a value of the wrong type
    /// stops the refinement, at any depth, and a valid one lets it run.
    #[test]
    fn a_value_of_the_wrong_type_stops_the_refinement() {
        assert_eq!(issues(&json!({})), "REFINED");
        assert_eq!(issues(&json!({ "f": true })), "REFINED");
        assert_eq!(
            issues(&json!({ "f": "x" })),
            "f: Invalid input: expected boolean, received string"
        );
        assert_eq!(
            issues(&json!({ "o": { "g": 1 } })),
            "o.g: Invalid input: expected boolean, received number"
        );
        assert_eq!(issues(&json!({ "o": { "g": true } })), "REFINED");
        assert_eq!(
            issues(&json!({ "o": 3 })),
            "o: Invalid input: expected object, received number"
        );
    }
}

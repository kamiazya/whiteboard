//! A request's params judged as the SDK's Zod schemas judge them, and the
//! refusal written as Zod writes it: every issue, in the schema's own key
//! order, as `JSON.stringify(issues, null, 2)`.
//!
//! Only the shapes the served requests' schemas use are here. A JSON value
//! is always a `JSONValue`, so `JSONObjectSchema` asks only for an object.

use serde_json::Value;

/// One Zod schema, as far as a JSON value can fail it.
pub(crate) enum Shape {
    String,
    Boolean,
    Number,
    /// `z.record(z.string(), JSONValueSchema)`: any object.
    JsonObject,
    /// `z.record(z.string(), shape)`.
    Record(&'static Shape),
    Array(&'static Shape),
    /// `z.object` (loose or not: an unknown key is never an issue).
    Object(&'static [Field]),
    /// `z.enum`: one of the listed strings.
    Enum(&'static [&'static str]),
    /// `z.intersection`: both sides' issues, the left's first.
    Both(&'static Shape, &'static Shape),
}

/// A member of an object shape.
pub(crate) struct Field {
    pub(crate) name: &'static str,
    pub(crate) shape: Shape,
    pub(crate) optional: bool,
}

/// What a value failed.
enum Fault {
    Type { expected: &'static str, received: &'static str },
    Value { values: &'static [&'static str] },
}

/// One step of an issue's path.
#[derive(Clone)]
enum Step {
    Key(String),
    Index(usize),
}

struct Issue {
    fault: Fault,
    path: Vec<Step>,
}

/// Judges `params` (`None`: absent) against `shape` under the path
/// `params`, answering Zod's message for its issues, if any.
pub(crate) fn refusal(shape: &Shape, params: Option<&Value>) -> Option<String> {
    let mut path = vec![Step::Key("params".into())];
    let mut issues = Vec::new();
    check(shape, params, &mut path, &mut issues);
    (!issues.is_empty()).then(|| message(&issues))
}

fn check(shape: &Shape, value: Option<&Value>, path: &mut Vec<Step>, issues: &mut Vec<Issue>) {
    let holds = match shape {
        Shape::String => value.is_some_and(Value::is_string),
        Shape::Boolean => value.is_some_and(Value::is_boolean),
        Shape::Number => value.is_some_and(Value::is_number),
        Shape::JsonObject => value.is_some_and(Value::is_object),
        Shape::Record(inner) => value
            .and_then(Value::as_object)
            .map(|map| {
                for (key, value) in map {
                    within(Step::Key(key.clone()), inner, Some(value), path, issues);
                }
            })
            .is_some(),
        Shape::Array(inner) => value
            .and_then(Value::as_array)
            .map(|items| {
                for (index, item) in items.iter().enumerate() {
                    within(Step::Index(index), inner, Some(item), path, issues);
                }
            })
            .is_some(),
        Shape::Object(fields) => value
            .and_then(Value::as_object)
            .map(|map| {
                for field in *fields {
                    let member = map.get(field.name);
                    if member.is_some() || !field.optional {
                        within(Step::Key(field.name.into()), &field.shape, member, path, issues);
                    }
                }
            })
            .is_some(),
        Shape::Enum(values) => {
            if !value.and_then(Value::as_str).is_some_and(|text| values.contains(&text)) {
                issues.push(Issue { fault: Fault::Value { values }, path: path.clone() });
            }
            true
        }
        Shape::Both(left, right) => {
            check(left, value, path, issues);
            check(right, value, path, issues);
            true
        }
    };
    if !holds {
        let fault = Fault::Type { expected: expected(shape), received: received(value) };
        issues.push(Issue { fault, path: path.clone() });
    }
}

/// The type Zod names a shape by when a value is not of it.
fn expected(shape: &Shape) -> &'static str {
    match shape {
        Shape::String => "string",
        Shape::Boolean => "boolean",
        Shape::Number => "number",
        Shape::JsonObject | Shape::Record(_) => "record",
        Shape::Array(_) => "array",
        Shape::Object(_) | Shape::Enum(_) | Shape::Both(..) => "object",
    }
}

fn within(
    step: Step,
    shape: &Shape,
    value: Option<&Value>,
    path: &mut Vec<Step>,
    issues: &mut Vec<Issue>,
) {
    path.push(step);
    check(shape, value, path, issues);
    path.pop();
}

/// The type Zod names a value by when it refuses it.
pub(crate) fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// `JSON.stringify(issues, null, 2)`, each issue's members in the order Zod
/// writes them.
fn message(issues: &[Issue]) -> String {
    let issues: Vec<String> = issues.iter().map(issue_text).collect();
    format!("[\n{}\n]", issues.join(",\n"))
}

fn issue_text(issue: &Issue) -> String {
    let path: Vec<String> = issue.path.iter().map(step_text).collect();
    let path = list("path", &path);
    let members = match &issue.fault {
        Fault::Type { expected, received } => [
            member("expected", &quoted(expected)),
            member("code", &quoted("invalid_type")),
            path,
            member(
                "message",
                &quoted(&format!("Invalid input: expected {expected}, received {received}")),
            ),
        ],
        Fault::Value { values } => {
            let quoted_values: Vec<String> = values.iter().map(|value| quoted(value)).collect();
            [
                member("code", &quoted("invalid_value")),
                list("values", &quoted_values),
                path,
                member(
                    "message",
                    &quoted(&format!(
                        "Invalid option: expected one of {}",
                        quoted_values.join("|")
                    )),
                ),
            ]
        }
    };
    format!("  {{\n{}\n  }}", members.join(",\n"))
}

fn member(name: &str, value: &str) -> String {
    format!("    \"{name}\": {value}")
}

/// A member holding a list, one item a line; never empty here.
fn list(name: &str, items: &[String]) -> String {
    let lines: Vec<String> = items.iter().map(|item| format!("      {item}")).collect();
    format!("    \"{name}\": [\n{}\n    ]", lines.join(",\n"))
}

fn step_text(step: &Step) -> String {
    match step {
        Step::Key(key) => quoted(key),
        Step::Index(index) => index.to_string(),
    }
}

/// A JSON string, escaped as `JSON.stringify` escapes a well-formed one.
fn quoted(text: &str) -> String {
    Value::from(text).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    static KEYED: Shape = Shape::Record(&Shape::String);

    /// A record key reaches the message as JSON.stringify writes it, escapes
    /// included; the recording's keys are all plain.
    #[test]
    fn a_record_key_is_escaped_as_json_stringify_escapes_it() {
        let params = json!({ "a\"\n\u{1}\u{7f}": 1 });
        let message = refusal(&KEYED, Some(&params)).unwrap();
        assert!(message.contains("      \"a\\\"\\n\\u0001\u{7f}\""), "{message}");
    }

    #[test]
    fn a_shape_the_value_meets_has_no_refusal() {
        assert_eq!(refusal(&KEYED, Some(&json!({ "a": "b" }))), None);
    }
}

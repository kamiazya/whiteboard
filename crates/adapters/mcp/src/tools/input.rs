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

/// A strict object: each field required, and any other key refused.
pub(crate) struct Input {
    pub(crate) fields: &'static [Field],
}

/// A string member, refined by `test` and refused with `message` when the
/// string fails it.
pub(crate) struct Field {
    pub(crate) name: &'static str,
    pub(crate) test: fn(&str) -> bool,
    pub(crate) message: &'static str,
}

/// The SDK's refusal of `arguments` for the tool `tool`, if it refuses them.
pub(crate) fn refusal(tool: &str, input: &Input, arguments: &Map<String, Value>) -> Option<String> {
    let mut issues: Vec<String> = input
        .fields
        .iter()
        .filter_map(|field| field_issue(field, arguments.get(field.name)))
        .collect();
    // Zod names the keys in the order the client wrote them; a serde_json
    // map has sorted them already.
    let unknown: Vec<String> = arguments
        .keys()
        .filter(|key| !input.fields.iter().any(|field| field.name == key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    if !unknown.is_empty() {
        let plural = if unknown.len() > 1 { "s" } else { "" };
        issues.push(format!("Unrecognized key{plural}: {}", unknown.join(", ")));
    }
    (!issues.is_empty()).then(|| {
        format!("Input validation error: Invalid arguments for tool {tool}: {}", issues.join(", "))
    })
}

fn field_issue(field: &Field, value: Option<&Value>) -> Option<String> {
    match value.and_then(Value::as_str) {
        Some(text) if (field.test)(text) => None,
        Some(_) => Some(format!("{}: {}", field.name, field.message)),
        None => Some(format!(
            "{}: Invalid input: expected string, received {}",
            field.name,
            received(value)
        )),
    }
}

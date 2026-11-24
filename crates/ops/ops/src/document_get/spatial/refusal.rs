//! A canvas the strict mode refuses, in the words the TypeScript reports it
//! with. The shim throws its places as a `ZodError` (`code`, `path`,
//! `message`, a message the codec does not word being the shim's text for
//! its code); `DocumentSerializeError` describes that error as
//! `describeThrown` does, and a Zod 4 error is no `Error` to `instanceof`, so
//! it is described as its JSON: `{"name":"ZodError","message":...}`, the
//! message being the issues as `JSON.stringify(issues, null, 2)` writes them,
//! and the whole cut at `DESCRIBE_THROWN_MAX` UTF-16 units.

use whiteboard_api_contracts::Refusal;
use whiteboard_codec::json_canvas::{Code, Issue, PathStep, json_text};
use whiteboard_model::Value;

/// `DESCRIBE_THROWN_MAX`: the longest description, in UTF-16 units.
const DESCRIBE_THROWN_MAX: usize = 500;

/// The shim's text for an issue whose code Zod words itself.
const fn worded(code: Code) -> &'static str {
    match code {
        Code::InvalidType => "Invalid input: wrong type",
        Code::TooSmall => "Too small",
        Code::TooBig => "Too big",
        Code::InvalidFormat => "Invalid string: wrong format",
        Code::InvalidValue => "Invalid option",
        Code::InvalidUnion | Code::Custom => "Invalid input",
    }
}

/// The reason a document whose canvas the strict mode refused at `issues` is
/// not read, or `None` where the shim answers otherwise: no place at all, or
/// a cut that would split a surrogate pair, which a Rust string cannot hold.
pub(super) fn serialize_failed(document_id: &str, issues: &[Issue]) -> Option<String> {
    if issues.is_empty() {
        return None;
    }
    let error = Value::Map(vec![
        ("name".to_owned(), Value::String("ZodError".to_owned())),
        ("message".to_owned(), Value::String(listed(issues)?)),
    ]);
    let cause = described(&json_text(&error)?)?;
    let format = "JSON Canvas".to_owned();
    Some(
        Refusal::DocumentSerializeFailed { cause, document_id: document_id.to_owned(), format }
            .message(),
    )
}

/// `JSON.stringify(issues, null, 2)`.
fn listed(issues: &[Issue]) -> Option<String> {
    let items = issues.iter().map(issue).collect::<Option<Vec<_>>>()?;
    Some(format!("[\n{}\n]", items.join(",\n")))
}

fn issue(issue: &Issue) -> Option<String> {
    let steps = issue
        .path
        .iter()
        .map(|step| match step {
            PathStep::Key(name) => quoted(name),
            PathStep::Index(at) => Some(at.to_string()),
        })
        .collect::<Option<Vec<_>>>()?;
    let path = if steps.is_empty() {
        "[]".to_owned()
    } else {
        format!("[\n      {}\n    ]", steps.join(",\n      "))
    };
    let message = quoted(issue.message.as_deref().unwrap_or(worded(issue.code)))?;
    let code = quoted(issue.code.as_str())?;
    Some(format!(
        "  {{\n    \"code\": {code},\n    \"path\": {path},\n    \"message\": {message}\n  }}"
    ))
}

fn quoted(text: &str) -> Option<String> {
    json_text(&Value::String(text.to_owned()))
}

/// `text`, or its first [`DESCRIBE_THROWN_MAX`] units and an ellipsis when it
/// is longer; `None` when the cut falls inside a surrogate pair.
fn described(text: &str) -> Option<String> {
    let mut units = 0_usize;
    for (at, c) in text.char_indices() {
        let next = units.saturating_add(c.len_utf16());
        if next > DESCRIBE_THROWN_MAX {
            let whole = units == DESCRIBE_THROWN_MAX;
            return text.get(..at).filter(|_| whole).map(|head| format!("{head}…"));
        }
        units = next;
    }
    Some(text.to_owned())
}

#[cfg(test)]
mod tests;

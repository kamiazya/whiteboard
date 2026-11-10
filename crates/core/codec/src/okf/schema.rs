//! `okfMarkdownFrontmatterSchema` over a parsed frontmatter, and the routing
//! `parseOkf` does before it: unknown root keys into `facetsRaw`, a bare
//! `verified` mapping widened to a list.
//!
//! Zod reports every refusal it finds, fields in the order the schema
//! declares them, so this does too, and an [`Issue`] is where and why.

use super::document::{Code, Detail, Issue, Map};
use super::js::length_below_one;
use crate::frontmatter::Step;
use crate::frontmatter::Value;
use whiteboard_model::checks::{
    RESERVED_ROOT_KEYS, extension_facet_keys, okf_actor, okf_timestamp,
};
use whiteboard_model::okf::{OkfMarkdownFrontmatter, OkfTrustEvent};

/// The frontmatter a parsed YAML value stands for, or every place the
/// schema refuses it. A value that is not a mapping is refused at the root.
pub(super) fn frontmatter(value: Value) -> Result<OkfMarkdownFrontmatter, Vec<Issue>> {
    let Value::Map(entries) = value else {
        return Err(vec![wrong_type(&[], "object", Some(&value))]);
    };
    let (mut known, raw) = route(entries);
    let mut issues = Vec::new();
    let r#type = required_text(take(&mut known, "type"), "type", &mut issues);
    let title = optional_text(take(&mut known, "title"), "title", &mut issues);
    let description = optional_text(take(&mut known, "description"), "description", &mut issues);
    let resource = optional_text(take(&mut known, "resource"), "resource", &mut issues);
    let tags = optional_tags(take(&mut known, "tags"), &mut issues);
    let view = optional_text(take(&mut known, "view"), "view", &mut issues);
    let generated =
        take(&mut known, "generated").and_then(|v| event(v, &[key("generated")], &mut issues));
    let verified = verified(take(&mut known, "verified"), &mut issues);
    let facets = facets(take(&mut known, "facets"), &mut issues);
    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(OkfMarkdownFrontmatter {
        r#type: r#type.unwrap_or_default(),
        title,
        description,
        resource,
        tags,
        view,
        generated,
        verified,
        facets,
        facets_raw: raw,
    })
}

/// `routeUnknownRootKeys`: the keys the schema models, with `verified`
/// widened, and every other key kept as written.
fn route(entries: Map) -> (Map, Option<Map>) {
    let (known, raw): (Map, Map) =
        entries.into_iter().partition(|(name, _)| RESERVED_ROOT_KEYS.contains(&name.as_str()));
    let known = known
        .into_iter()
        .map(|(name, item)| if name == "verified" { (name, widen(item)) } else { (name, item) })
        .collect();
    (known, if raw.is_empty() { None } else { Some(raw) })
}

/// OKF §5.2 makes a bare `verified` mapping a list of one.
fn widen(value: Value) -> Value {
    match value {
        mapping @ Value::Map(_) => Value::Seq(vec![mapping]),
        other => other,
    }
}

fn take(known: &mut Map, name: &str) -> Option<Value> {
    let at = known.iter().position(|(k, _)| k == name)?;
    Some(known.remove(at).1)
}

fn key(name: &str) -> Step {
    Step::Key(name.to_string())
}

fn issue(path: &[Step], code: Code, detail: Detail) -> Issue {
    Issue { path: path.to_vec(), code, detail }
}

/// `invalid_type`: `expected` is Zod's word for the type, and a `None` value
/// is a key the schema requires that is not there.
fn wrong_type(path: &[Step], expected: &'static str, value: Option<&Value>) -> Issue {
    let received = value.map_or("undefined", received);
    issue(path, Code::InvalidType, Detail::Type { expected, received })
}

/// What Zod names a value it received: its `parsedType`, except that a
/// number that is not finite is named by its value.
fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(n) if n.is_nan() => "NaN",
        Value::Number(n) if n.is_infinite() => {
            if n.is_sign_positive() {
                "Infinity"
            } else {
                "-Infinity"
            }
        }
        Value::Number(_) => "number",
        Value::BigInt(_) => "bigint",
        Value::String(_) => "string",
        Value::Seq(_) => "array",
        Value::Map(_) => "object",
    }
}

/// `too_small` of `min(1)` on a string, or on what the check measured instead.
fn too_small(path: &[Step], measured: &'static str) -> Issue {
    issue(path, Code::TooSmall, Detail::Measured(measured))
}

fn text(value: Value, path: &[Step], issues: &mut Vec<Issue>) -> Option<String> {
    let Value::String(text) = value else {
        issues.push(wrong_type(path, "string", Some(&value)));
        return None;
    };
    Some(text)
}

/// A string at `path`. Under `min(1)` a value that is no string but has a
/// `length` is also measured, as Zod measures it.
fn text_measured(
    value: Value,
    path: &[Step],
    non_empty: bool,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    if non_empty && !matches!(value, Value::String(_)) && length_below_one(&value) {
        issues.push(wrong_type(path, "string", Some(&value)));
        issues.push(too_small(path, measured(&value)));
        return None;
    }
    text(value, path, issues)
}

/// What `min(1)` measured in a value that is no string: a list's items, or
/// the `length` of anything else.
fn measured(value: &Value) -> &'static str {
    if matches!(value, Value::Seq(_)) { "array" } else { "unknown" }
}

/// `z.string().min(1)`, required.
fn required_text(value: Option<Value>, name: &str, issues: &mut Vec<Issue>) -> Option<String> {
    let path = [key(name)];
    let Some(value) = value else {
        issues.push(wrong_type(&path, "string", None));
        return None;
    };
    let found = text_measured(value, &path, true, issues)?;
    if found.is_empty() {
        issues.push(too_small(&path, "string"));
    }
    Some(found)
}

fn optional_text(value: Option<Value>, name: &str, issues: &mut Vec<Issue>) -> Option<String> {
    text(value?, &[key(name)], issues)
}

fn optional_tags(value: Option<Value>, issues: &mut Vec<Issue>) -> Option<Vec<String>> {
    let value = value?;
    let Value::Seq(items) = value else {
        issues.push(wrong_type(&[key("tags")], "array", Some(&value)));
        return None;
    };
    let tags: Vec<Option<String>> = items
        .into_iter()
        .enumerate()
        .map(|(index, item)| text(item, &[key("tags"), Step::Index(index)], issues))
        .collect();
    tags.into_iter().collect()
}

fn verified(value: Option<Value>, issues: &mut Vec<Issue>) -> Option<Vec<OkfTrustEvent>> {
    let value = value?;
    let Value::Seq(items) = value else {
        issues.push(wrong_type(&[key("verified")], "array", Some(&value)));
        return None;
    };
    let events: Vec<Option<OkfTrustEvent>> = items
        .into_iter()
        .enumerate()
        .map(|(index, item)| event(item, &[key("verified"), Step::Index(index)], issues))
        .collect();
    events.into_iter().collect()
}

/// `okfTrustEventSchema`: `by` and `at` required, anything else kept.
fn event(value: Value, path: &[Step], issues: &mut Vec<Issue>) -> Option<OkfTrustEvent> {
    let Value::Map(entries) = value else {
        issues.push(wrong_type(path, "object", Some(&value)));
        return None;
    };
    let (mut named, extra): (Map, Map) =
        entries.into_iter().partition(|(name, _)| name == "by" || name == "at");
    let by = event_text(take(&mut named, "by"), path, "by", true, actor_problem, issues);
    let at = event_text(take(&mut named, "at"), path, "at", false, timestamp_problem, issues);
    Some(OkfTrustEvent { by: by?, at: at?, extra })
}

/// A string of an event that `problem` has no complaint about.
fn event_text(
    value: Option<Value>,
    path: &[Step],
    name: &str,
    non_empty: bool,
    problem: fn(&str) -> Option<(Code, Detail)>,
    issues: &mut Vec<Issue>,
) -> Option<String> {
    let at = [path, &[key(name)]].concat();
    let Some(value) = value else {
        issues.push(wrong_type(&at, "string", None));
        return None;
    };
    let found = text_measured(value, &at, non_empty, issues)?;
    if let Some((code, detail)) = problem(&found) {
        issues.push(issue(&at, code, detail));
        return None;
    }
    Some(found)
}

/// `okfActorSchema`: a non-empty single line with no surrounding white space.
fn actor_problem(actor: &str) -> Option<(Code, Detail)> {
    if actor.is_empty() {
        Some((Code::TooSmall, Detail::Measured("string")))
    } else if !okf_actor(actor) {
        Some((Code::Custom, Detail::Rule("actor")))
    } else {
        None
    }
}

/// `okfTimestampSchema`: matched by the model's `okf_timestamp`.
fn timestamp_problem(timestamp: &str) -> Option<(Code, Detail)> {
    if okf_timestamp(timestamp) { None } else { Some((Code::InvalidFormat, Detail::Nothing)) }
}

/// `extensionFacetsSchema`: a mapping whose keys are `{namespace}.{name}/v{n}`.
fn facets(value: Option<Value>, issues: &mut Vec<Issue>) -> Option<Map> {
    let value = value?;
    let Value::Map(entries) = value else {
        issues.push(wrong_type(&[key("facets")], "record", Some(&value)));
        return None;
    };
    for name in extension_facet_keys(&entries) {
        issues.push(issue(&[key("facets"), key(name)], Code::Custom, Detail::Rule("facet-key")));
    }
    Some(entries)
}

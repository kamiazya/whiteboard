//! The members of a `wb_body_edit` op as the SDK judges them: an id, an
//! actor, a passage's anchor and its texts. Each is worded as the recording
//! holds it, a value that is no string included, which Zod still holds to the
//! length checks of the string it was asked for.

use serde_json::{Map, Value};
use whiteboard_model::checks::is_js_space;

use crate::tools::input::{Checked, Field, Kind, at, characters, expected, object_issues};

/// `ID_MAX_CHARS`, `OKF_ACTOR_MAX_CHARS`, `TEXT_ANCHOR_CONTEXT_MAX_CHARS`,
/// `TEXT_ANCHOR_QUOTE_MAX_CHARS`, `MARKDOWN_MAX_CHARS` and the largest
/// integer a double holds.
const ID_MAX: usize = 256;
const ACTOR_MAX: usize = 256;
const CONTEXT_MAX: usize = 32;
const QUOTE_MAX: usize = 1024;
const ASSUMED_MAX: usize = 262_144;
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A length as the double a JavaScript comparison holds; the schemas' bounds
/// and any list a call carries are far below `u32::MAX`.
fn double(length: usize) -> f64 {
    f64::from(u32::try_from(length).unwrap_or(u32::MAX))
}

/// How a schema bounds a string below.
#[derive(Clone, Copy)]
enum Floor {
    /// No lower bound.
    None,
    /// `min(1)` with the schema's own words.
    Words(&'static str),
    /// `min(1)` in Zod's.
    Default,
}

/// How a schema bounds a string: a floor of one character, and a ceiling in
/// characters and in UTF-16 units refused with the schema's words.
#[derive(Clone, Copy)]
struct Bounds {
    floor: Floor,
    ceiling: Option<(usize, &'static str)>,
}

/// Whether the floor is broken, and in whose words: the schema's, or Zod's for
/// the kind of value that was given.
fn too_small(path: &str, floor: Floor, kind: &str) -> Option<String> {
    let default = match kind {
        "string" => "Too small: expected string to have >=1 characters",
        "array" => "Too small: expected array to have >=1 items",
        _ => "Too small: expected unknown to be >=1",
    };
    match floor {
        Floor::None => None,
        Floor::Words(words) => Some(at(path, words)),
        Floor::Default => Some(at(path, default)),
    }
}

/// The issues of a value that is no string, as Zod words them: the type, and
/// then the length checks of the string schema, judged on any value that has a
/// length.
fn not_a_string(path: &str, value: Option<&Value>, bounds: Bounds) -> Vec<String> {
    let length = match value {
        Some(Value::Array(items)) => Some((double(items.len()), "array")),
        Some(Value::Object(held)) => {
            held.get("length").and_then(Value::as_f64).map(|n| (n, "object"))
        }
        _ => None,
    };
    let mut issues = vec![expected(path, "string", value)];
    let Some((length, kind)) = length else { return issues };
    if length < 1.0 {
        issues.extend(too_small(path, bounds.floor, kind));
    }
    if let Some((max, words)) = bounds.ceiling
        && length > double(max)
    {
        issues.push(at(path, words));
    }
    issues
}

/// A string within `bounds`: refused empty, and refused past its ceiling in
/// characters or in UTF-16 units.
fn string_issues(path: &str, value: Option<&Value>, bounds: Bounds) -> Vec<String> {
    let Some(Value::String(held)) = value else { return not_a_string(path, value, bounds) };
    if held.is_empty() {
        return too_small(path, bounds.floor, "string").into_iter().collect();
    }
    match bounds.ceiling {
        Some((max, words)) if characters(held) > max || held.encode_utf16().count() > max => {
            vec![at(path, words)]
        }
        _ => Vec::new(),
    }
}

fn optional(
    value: Option<&Value>,
    judge: impl FnOnce(Option<&Value>) -> Vec<String>,
) -> Vec<String> {
    value.map_or_else(Vec::new, |held| judge(Some(held)))
}

/// `annotationIdInputSchema`, a name given to a change or a proposal.
const NEW_ID: Bounds = Bounds {
    floor: Floor::Words("annotation id must not be empty"),
    ceiling: Some((ID_MAX, "an id is longer than the 256-character limit for one id")),
};

/// A change's id: required.
pub(super) const CHANGE_ID: Checked = Checked {
    issues: |path, value| match value {
        None => vec![expected(path, "string", None)],
        Some(_) => string_issues(path, value, NEW_ID),
    },
    aborts: None,
};

/// A proposal's id: optional.
pub(super) const PROPOSAL_ID: Checked = Checked {
    issues: |path, value| optional(value, |held| string_issues(path, held, NEW_ID)),
    aborts: None,
};

/// An actor: `okfActorInputSchema`, a non-blank single-line string. Its
/// refinement is judged before the bound that follows it, and beside it.
pub(super) const AUTHOR: Checked = Checked {
    issues: |path, value| {
        optional(value, |held| {
            let bounds = Bounds {
                floor: Floor::Default,
                ceiling: Some((ACTOR_MAX, "an actor is longer than the 256-character limit")),
            };
            let issues = string_issues(path, held, bounds);
            let Some(Value::String(actor)) = held else { return issues };
            let lined = actor.starts_with(is_js_space)
                || actor.ends_with(is_js_space)
                || actor.contains(['\r', '\n']);
            if !lined {
                return issues;
            }
            let words = "an OKF actor is a single-line string with no surrounding whitespace";
            std::iter::once(at(path, words)).chain(issues).collect()
        })
    },
    aborts: None,
};

/// The literal `name` an op or an anchor calls itself by.
fn literal(path: &str, value: Option<&Value>, name: &str) -> Vec<String> {
    match value {
        Some(Value::String(held)) if held == name => Vec::new(),
        _ => vec![at(path, &format!("Invalid input: expected \"{name}\""))],
    }
}

pub(super) const OP_NAME: Checked =
    Checked { issues: |path, value| literal(path, value, "body.replace"), aborts: None };

const KIND_NAME: Checked =
    Checked { issues: |path, value| literal(path, value, "text"), aborts: None };

/// A text node's id in an anchor: `nodeIdSchema`.
const NODE_ID: Checked = Checked {
    issues: |path, value| {
        let bounds = Bounds { floor: Floor::Words("node id must not be empty"), ceiling: None };
        optional(value, |held| string_issues(path, held, bounds))
    },
    aborts: None,
};

/// `nonnegativeIntegerSchema`: a fraction is no integer whatever its sign,
/// and a whole number out of the safe range breaks the integer bound, and the
/// floor beside it when it is below.
fn offset(path: &str, value: Option<&Value>) -> Vec<String> {
    let Some(Value::Number(held)) = value else { return vec![expected(path, "number", value)] };
    let n = held.as_f64().unwrap_or(f64::NAN);
    let floor = at(path, "Too small: expected number to be >=0");
    if n.fract() != 0.0 {
        vec![expected(path, "int", value)]
    } else if n > SAFE_INTEGER {
        vec![at(path, "Too big: expected int to be <=9007199254740991")]
    } else if n < -SAFE_INTEGER {
        vec![at(path, "Too small: expected int to be >=-9007199254740991"), floor]
    } else if n < 0.0 {
        vec![floor]
    } else {
        Vec::new()
    }
}

const OFFSET: Checked = Checked { issues: offset, aborts: None };

/// A context beside a quote, which a tool bounds.
const CONTEXT: Checked = Checked {
    issues: |path, value| {
        let words = "a text anchor's context is longer than the 32-character limit; keep the characters nearest the passage";
        let bounds = Bounds { floor: Floor::None, ceiling: Some((CONTEXT_MAX, words)) };
        optional(value, |held| string_issues(path, held, bounds))
    },
    aborts: None,
};

const EXACT: Checked = Checked {
    issues: |path, value| {
        if value.is_none() {
            return vec![expected(path, "string", None)];
        }
        let words = "a text anchor's quote is longer than the 1024-character limit for the passage one anchor quotes; quote a shorter passage, or split a replacement across changes";
        let bounds = Bounds {
            floor: Floor::Words("a text anchor must quote at least one character"),
            ceiling: Some((QUOTE_MAX, words)),
        };
        string_issues(path, value, bounds)
    },
    aborts: None,
};

const QUOTE_FIELDS: &[Field] = &[
    Field { name: "prefix", kind: Kind::Checked(CONTEXT) },
    Field { name: "exact", kind: Kind::Checked(EXACT) },
    Field { name: "suffix", kind: Kind::Checked(CONTEXT) },
];

const QUOTE: Checked = Checked {
    issues: |path, value| match value {
        Some(Value::Object(quote)) => object_issues(path, QUOTE_FIELDS, quote),
        other => vec![expected(path, "object", other)],
    },
    aborts: None,
};

const ANCHOR_FIELDS: &[Field] = &[
    Field { name: "kind", kind: Kind::Checked(KIND_NAME) },
    Field { name: "nodeId", kind: Kind::Checked(NODE_ID) },
    Field { name: "quote", kind: Kind::Checked(QUOTE) },
    Field { name: "start", kind: Kind::Checked(OFFSET) },
    Field { name: "end", kind: Kind::Checked(OFFSET) },
];

/// An anchor: the text arm, whose passage does not end before it starts.
pub(super) const ANCHOR: Checked = Checked { issues: anchor_issues, aborts: None };

fn ends_early(anchor: &Map<String, Value>) -> bool {
    let number = |key: &str| anchor.get(key).and_then(Value::as_f64);
    matches!((number("start"), number("end")), (Some(start), Some(end)) if end < start)
}

/// The refinement runs after every fault a bound or a stray key makes, and is
/// skipped after one of type: a value of the wrong type, a literal that
/// differs, a fraction, or a member that is missing.
fn anchor_issues(path: &str, value: Option<&Value>) -> Vec<String> {
    let Some(Value::Object(anchor)) = value else {
        return vec![expected(path, "object", value)];
    };
    let issues = object_issues(path, ANCHOR_FIELDS, anchor);
    let aborted = issues.iter().any(|issue| issue.contains("Invalid input: expected"));
    if aborted || !ends_early(anchor) {
        return issues;
    }
    let words = "a text anchor must not end before it starts";
    issues.into_iter().chain(std::iter::once(at(path, words))).collect()
}

/// `text`: any string.
pub(super) const TEXT: Checked = Checked {
    issues: |path, value| match value {
        Some(Value::String(_)) => Vec::new(),
        other => vec![expected(path, "string", other)],
    },
    aborts: None,
};

/// `assumed`: a string held to the body limit.
pub(super) const ASSUMED: Checked = Checked {
    issues: |path, value| {
        let words = "a passage's prior text is longer than the 262144-character limit for one document; split the content across documents";
        let bounds = Bounds { floor: Floor::None, ceiling: Some((ASSUMED_MAX, words)) };
        match value {
            None => vec![expected(path, "string", None)],
            Some(_) => string_issues(path, value, bounds),
        }
    },
    aborts: None,
};

//! The members of a `wb_thread_edit` op as the SDK judges them: an id, a
//! message, an actor, a flag and the anchor with its arms. Each is worded
//! as the recording holds it, one fault at a time.

use serde_json::{Map, Value};
use whiteboard_ops::is_js_space;

use super::joined;
use crate::tools::input::{Checked, Field, Kind, at, characters, expected, object_issues};

/// A refusal this binding has no recording of: the call is answered as a
/// pending tool, never in words guessed.
pub(crate) const UNJUDGED: &str = "\u{0}unjudged";

/// `ID_MAX_CHARS`, `COMMENT_MESSAGE_MAX_CHARS`, `OKF_ACTOR_MAX_CHARS`,
/// `TEXT_ANCHOR_CONTEXT_MAX_CHARS`, `TEXT_ANCHOR_QUOTE_MAX_CHARS` and
/// `CANVAS_MAX_NODES`.
const ID_MAX: usize = 256;
const BODY_MAX: usize = 4096;
const ACTOR_MAX: usize = 256;
const CONTEXT_MAX: usize = 32;
const QUOTE_MAX: usize = 1024;
const NODES_MAX: usize = 2000;
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// The faults of one op, or the marker when they are more than the recording
/// words alone.
pub(super) fn single(issues: Vec<String>) -> Vec<String> {
    if issues.len() > 1 { vec![UNJUDGED.to_owned()] } else { issues }
}

/// A value that is no string, as Zod words it for a string schema; an array
/// or an object is also judged for a length it may carry.
fn not_a_string(path: &str, value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(_) | Value::Object(_)) => vec![UNJUDGED.to_owned()],
        other => vec![expected(path, "string", other)],
    }
}

/// A string no longer than `max` in characters and in UTF-16 units, refused
/// past either with `too_big`. A string of nothing is `empty`'s.
fn string_issues(
    path: &str,
    value: Option<&Value>,
    (empty, max, too_big): (&str, usize, Option<&str>),
) -> Vec<String> {
    let Some(Value::String(held)) = value else { return not_a_string(path, value) };
    if held.is_empty() {
        return vec![at(path, empty)];
    }
    match too_big {
        Some(words) if characters(held) > max || held.encode_utf16().count() > max => {
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

/// A thread's id as it is chosen: `annotationIdInputSchema`.
pub(super) const NEW_ID: Checked = Checked {
    issues: |path, value| {
        optional(value, |held| {
            let words = "an id is longer than the 256-character limit for one id";
            string_issues(path, held, ("annotation id must not be empty", ID_MAX, Some(words)))
        })
    },
    aborts: None,
};

/// A thread's id as it is named: `annotationIdSchema`, required and unbounded.
pub(super) const THREAD_ID: Checked = Checked {
    issues: |path, value| {
        string_issues(path, value, ("annotation id must not be empty", ID_MAX, None))
    },
    aborts: None,
};

/// A message: `commentMessageInputSchema`, required.
pub(super) const BODY: Checked = Checked {
    issues: |path, value| {
        let words =
            "a comment message is longer than the 4096-character limit; split it across replies";
        string_issues(path, value, ("a comment message must not be empty", BODY_MAX, Some(words)))
    },
    aborts: None,
};

/// An actor: `okfActorInputSchema`, a non-blank single-line string.
pub(super) const AUTHOR: Checked = Checked {
    issues: |path, value| {
        optional(value, |held| {
            let words = "an actor is longer than the 256-character limit";
            let empty = "Too small: expected string to have >=1 characters";
            let mut issues = string_issues(path, held, (empty, ACTOR_MAX, Some(words)));
            if let Some(Value::String(actor)) = held
                && issues.is_empty()
                && (actor.starts_with(is_js_space)
                    || actor.ends_with(is_js_space)
                    || actor.contains(['\r', '\n']))
            {
                let words = "an OKF actor is a single-line string with no surrounding whitespace";
                issues.push(at(path, words));
            }
            issues
        })
    },
    aborts: None,
};

/// `resolved`: an optional boolean.
pub(super) const RESOLVED: Checked = Checked {
    issues: |path, value| match value {
        None | Some(Value::Bool(_)) => Vec::new(),
        other => vec![expected(path, "boolean", other)],
    },
    aborts: None,
};

/// A node's or an edge's id in an anchor: `nodeIdSchema`.
const REFERENCE: Checked = Checked {
    issues: |path, value| {
        optional(value, |held| {
            string_issues(path, held, ("node id must not be empty", ID_MAX, None))
        })
    },
    aborts: None,
};

/// `integerSchema`, or `nonnegativeIntegerSchema`; one past the safe range is
/// not worded here.
fn whole(path: &str, value: Option<&Value>, floor: bool) -> Vec<String> {
    match value {
        Some(Value::Number(held)) => {
            let n = held.as_f64().unwrap_or(f64::NAN);
            if n.abs() > SAFE_INTEGER || (floor && n < 0.0 && n.fract() != 0.0) {
                vec![UNJUDGED.to_owned()]
            } else if n.fract() != 0.0 {
                vec![expected(path, "int", value)]
            } else if floor && n < 0.0 {
                vec![at(path, "Too small: expected number to be >=0")]
            } else {
                Vec::new()
            }
        }
        Some(Value::Array(_) | Value::Object(_)) => vec![UNJUDGED.to_owned()],
        other => vec![expected(path, "number", other)],
    }
}

fn required_int(floor: bool) -> impl Fn(&str, Option<&Value>) -> Vec<String> {
    move |path, value| whole(path, value, floor)
}

const X: Checked = Checked { issues: |path, value| required_int(false)(path, value), aborts: None };
const START: Checked =
    Checked { issues: |path, value| required_int(true)(path, value), aborts: None };
const SIZE: Checked =
    Checked { issues: |path, value| optional(value, |held| whole(path, held, true)), aborts: None };

/// `nodeIds`: two to 2000 node ids; an array out of bounds is refused for its
/// length alone.
const NODE_SET: Checked = Checked {
    issues: |path, value| {
        let Some(given) = value else { return Vec::new() };
        let Value::Array(ids) = given else { return vec![UNJUDGED.to_owned()] };
        let each = |ids: &[Value]| -> Vec<String> {
            ids.iter()
                .enumerate()
                .flat_map(|(at, id)| {
                    string_issues(
                        &joined(path, &at.to_string()),
                        Some(id),
                        ("node id must not be empty", ID_MAX, None),
                    )
                })
                .collect()
        };
        if ids.len() < 2 || ids.len() > NODES_MAX {
            let words = if ids.len() < 2 {
                "a node set names at least two nodes"
            } else {
                "a node set names more nodes than the 2000-node limit for one comment anchor, a whole canvas's worth"
            };
            return if each(ids).is_empty() {
                vec![at(path, words)]
            } else {
                vec![UNJUDGED.to_owned()]
            };
        }
        each(ids)
    },
    aborts: None,
};

/// A kind the anchor union names; judged before the arm it picks.
const KIND: Field = Field {
    name: "kind",
    kind: Kind::Checked(Checked { issues: |_, _| Vec::new(), aborts: None }),
};

const SPATIAL_FIELDS: &[Field] = &[
    KIND,
    Field { name: "nodeId", kind: Kind::Checked(REFERENCE) },
    Field { name: "edgeId", kind: Kind::Checked(REFERENCE) },
    Field { name: "nodeIds", kind: Kind::Checked(NODE_SET) },
    Field { name: "x", kind: Kind::Checked(X) },
    Field { name: "y", kind: Kind::Checked(X) },
    Field { name: "width", kind: Kind::Checked(SIZE) },
    Field { name: "height", kind: Kind::Checked(SIZE) },
];

const TEXT_FIELDS: &[Field] = &[
    KIND,
    Field { name: "nodeId", kind: Kind::Checked(REFERENCE) },
    Field { name: "quote", kind: Kind::Checked(QUOTE) },
    Field { name: "start", kind: Kind::Checked(START) },
    Field { name: "end", kind: Kind::Checked(START) },
];

const DOCUMENT_FIELDS: &[Field] = &[KIND];

/// A context beside a quote, which a tool bounds.
const CONTEXT: Checked = Checked {
    issues: |path, value| {
        optional(value, |held| {
            let words = "a text anchor's context is longer than the 32-character limit; keep the characters nearest the passage";
            let Some(Value::String(context)) = held else { return not_a_string(path, held) };
            let long =
                characters(context) > CONTEXT_MAX || context.encode_utf16().count() > CONTEXT_MAX;
            if long { vec![at(path, words)] } else { Vec::new() }
        })
    },
    aborts: None,
};

const EXACT: Checked = Checked {
    issues: |path, value| {
        let words = "a text anchor's quote is longer than the 1024-character limit for the passage one anchor quotes; quote a shorter passage, or split a replacement across changes";
        let empty = "a text anchor must quote at least one character";
        string_issues(path, value, (empty, QUOTE_MAX, Some(words)))
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
        Some(Value::Array(_)) => vec![UNJUDGED.to_owned()],
        other => vec![expected(path, "object", other)],
    },
    aborts: None,
};

/// The refinements of an arm that fail, in the schema's order.
type Refinements = fn(&Map<String, Value>) -> Vec<&'static str>;

/// An anchor: an object whose `kind` names an arm, held to that arm.
pub(super) const ANCHOR: Checked = Checked { issues: anchor_issues, aborts: None };

fn anchor_issues(path: &str, value: Option<&Value>) -> Vec<String> {
    let Some(Value::Object(anchor)) = value else {
        return match value {
            Some(Value::Array(_)) => vec![UNJUDGED.to_owned()],
            other => vec![expected(path, "object", other)],
        };
    };
    let (fields, refines): (&[Field], Refinements) =
        match anchor.get("kind").and_then(Value::as_str) {
            Some("spatial") => (SPATIAL_FIELDS, spatial_refinements),
            Some("text") => (TEXT_FIELDS, text_refinements),
            Some("document") => (DOCUMENT_FIELDS, |_| Vec::new()),
            _ => {
                let words = "Invalid discriminator value. Expected 'spatial' | 'text' | 'document'";
                return vec![at(&joined(path, "kind"), words)];
            }
        };
    let issues = object_issues(path, fields, anchor);
    let broken = refines(anchor);
    // A refinement runs over a parsed object; whether a fault of the object's
    // own stops it is not in the recording.
    match (issues.is_empty(), broken.len()) {
        (true, 0) => Vec::new(),
        (true, 1) => vec![at(path, broken.first().copied().unwrap_or_default())],
        (false, 0) => issues,
        _ => vec![UNJUDGED.to_owned()],
    }
}

fn refs(anchor: &Map<String, Value>, key: &str) -> bool {
    anchor.contains_key(key)
}

/// The spatial arm's refinements that fail, in the schema's order.
fn spatial_refinements(anchor: &Map<String, Value>) -> Vec<&'static str> {
    let named = ["nodeId", "edgeId", "nodeIds"].iter().filter(|key| refs(anchor, key)).count();
    let mut broken = Vec::new();
    if named > 1 {
        broken.push("a spatial anchor names a node, an edge or a node set, not two of them");
    }
    if let Some(Value::Array(ids)) = anchor.get("nodeIds") {
        let distinct: std::collections::BTreeSet<&str> =
            ids.iter().filter_map(Value::as_str).collect();
        if distinct.len() != ids.len() {
            broken.push("a node set names each node once");
        }
    }
    if refs(anchor, "width") != refs(anchor, "height") {
        broken.push("a region has both a width and a height");
    }
    broken
}

/// The text arm's one refinement: a passage does not end before it starts.
fn text_refinements(anchor: &Map<String, Value>) -> Vec<&'static str> {
    let number = |key: &str| anchor.get(key).and_then(Value::as_f64);
    match (number("start"), number("end")) {
        (Some(start), Some(end)) if end < start => {
            vec!["a text anchor must not end before it starts"]
        }
        _ => Vec::new(),
    }
}

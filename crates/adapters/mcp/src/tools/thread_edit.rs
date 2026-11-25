//! `wb_thread_edit` over `whiteboard-ops`'s `ThreadEdit`: its input judged as
//! the SDK judges it, the ops and anchors as far as the recording holds the
//! SDK's words, every refusal answered, and what the operation leaves pending
//! answered as a pending tool.
//!
//! A shape the SDK refuses in words this binding has no recording of (two
//! faults in one op, a fault of a kind no call exercised) is [`UNJUDGED`]:
//! the call is answered as a pending tool rather than in words guessed.

mod fields;

use serde_json::{Map, Value};
use whiteboard_model::Value as Plain;
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ops::{
    SpatialAnchor, TextPassage, ThreadAnchor, ThreadEdit, ThreadEditAnswer, ThreadEditInput,
    ThreadOp,
};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{Checked, Field, Input, Kind, Refined, at, expected, joined, object_issues};
use super::json::Json;

pub(super) use fields::UNJUDGED;

/// `OPS_PER_CALL_MAX`.
const OPS_MAX: usize = 200;
const NO_OPS: &str = "give at least one op";
const TOO_MANY_OPS: &str =
    "more ops than the 200-op limit for one call; split the batch across calls";
const OP_KINDS: &str =
    "Invalid discriminator value. Expected 'thread.add' | 'message.add' | 'thread.resolve'";

impl Binding for ThreadEdit {
    const NAME: &str = "wb_thread_edit";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_thread_edit.json");
    const INPUT: Input = Input {
        fields: &[
            WORKSPACE_ADDRESS,
            Field {
                name: "documentId",
                kind: Kind::Text(Refined {
                    test: canonical_ulid,
                    message: "must be a canonical ULID",
                }),
            },
            Field {
                name: "ops",
                kind: Kind::Checked(Checked { issues: ops_issues, aborts: None }),
            },
        ],
        refine: None,
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> ThreadEditInput {
        let ops = arguments.get("ops").and_then(Value::as_array);
        ThreadEditInput {
            workspace_id: workspace_id.unwrap_or_default(),
            document_id: text(arguments.get("documentId")).unwrap_or_default(),
            ops: ops.map(|ops| ops.iter().filter_map(op_of).collect()).unwrap_or_default(),
        }
    }

    fn output(answer: &ThreadEditAnswer) -> Option<Json> {
        let ThreadEditAnswer::Edited(edited) = answer else { return None };
        let threads = Json::Plain(Plain::Seq(edited.threads.clone()));
        Some(Json::Object(vec![("threads", threads)]))
    }

    fn unjudged(refusal: &str) -> bool {
        refusal.contains(UNJUDGED)
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn op_of(op: &Value) -> Option<ThreadOp> {
    let member = |key: &str| op.get(key);
    let thread_id = || text(member("threadId"));
    Some(match member("op")?.as_str()? {
        "thread.add" => ThreadOp::Add {
            thread_id: thread_id(),
            anchor: anchor_of(member("anchor")?)?,
            body: text(member("body"))?,
            author: text(member("author")),
        },
        "message.add" => ThreadOp::Reply {
            thread_id: thread_id()?,
            body: text(member("body"))?,
            author: text(member("author")),
        },
        _ => ThreadOp::Resolve {
            thread_id: thread_id()?,
            resolved: member("resolved").and_then(Value::as_bool),
        },
    })
}

fn anchor_of(anchor: &Value) -> Option<ThreadAnchor> {
    let member = |key: &str| anchor.get(key);
    let number = |key: &str| member(key).and_then(Value::as_f64);
    Some(match member("kind")?.as_str()? {
        "spatial" => ThreadAnchor::Spatial(SpatialAnchor {
            node_id: text(member("nodeId")),
            edge_id: text(member("edgeId")),
            node_ids: member("nodeIds")
                .and_then(Value::as_array)
                .map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect()),
            x: number("x")?,
            y: number("y")?,
            width: number("width"),
            height: number("height"),
        }),
        "text" => {
            let quote = member("quote")?;
            ThreadAnchor::Text(TextPassage {
                node_id: text(member("nodeId")),
                prefix: text(quote.get("prefix")),
                exact: text(quote.get("exact"))?,
                suffix: text(quote.get("suffix")),
                start: number("start")?,
                end: number("end")?,
            })
        }
        _ => ThreadAnchor::Document,
    })
}

/// `ops`: an array of one to 200 ops, each judged in turn; an array past the
/// bounds is refused for its length alone, before any item.
fn ops_issues(path: &str, value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(ops)) if ops.is_empty() => vec![at(path, NO_OPS)],
        Some(Value::Array(ops)) if ops.len() > OPS_MAX => vec![at(path, TOO_MANY_OPS)],
        Some(Value::Array(ops)) => ops
            .iter()
            .enumerate()
            .flat_map(|(position, op)| op_issues(&joined(path, &position.to_string()), op))
            .collect(),
        // A string is no array, and is judged for the length it has as one.
        Some(Value::String(text)) => {
            let length = match text.chars().count() {
                0 => Some(NO_OPS),
                1..=OPS_MAX => None,
                _ => Some(TOO_MANY_OPS),
            };
            std::iter::once(expected(path, "array", value))
                .chain(length.map(|words| at(path, words)))
                .collect()
        }
        Some(Value::Object(_)) => vec![UNJUDGED.to_owned()],
        other => vec![expected(path, "array", other)],
    }
}

const ADD_FIELDS: &[Field] = &[
    OP_KIND,
    Field { name: "threadId", kind: Kind::Checked(fields::NEW_ID) },
    Field { name: "anchor", kind: Kind::Checked(fields::ANCHOR) },
    Field { name: "body", kind: Kind::Checked(fields::BODY) },
    Field { name: "author", kind: Kind::Checked(fields::AUTHOR) },
];

const REPLY_FIELDS: &[Field] = &[
    OP_KIND,
    Field { name: "threadId", kind: Kind::Checked(fields::THREAD_ID) },
    Field { name: "body", kind: Kind::Checked(fields::BODY) },
    Field { name: "author", kind: Kind::Checked(fields::AUTHOR) },
];

const RESOLVE_FIELDS: &[Field] = &[
    OP_KIND,
    Field { name: "threadId", kind: Kind::Checked(fields::THREAD_ID) },
    Field { name: "resolved", kind: Kind::Checked(fields::RESOLVED) },
];

/// The discriminator, judged before the arm it picks.
const OP_KIND: Field =
    Field { name: "op", kind: Kind::Checked(Checked { issues: |_, _| Vec::new(), aborts: None }) };

/// One op: an object whose `op` names an arm, held to that arm's members.
/// Two faults in one op are not worded here.
fn op_issues(path: &str, op: &Value) -> Vec<String> {
    let Value::Object(members) = op else { return vec![expected(path, "object", Some(op))] };
    let fields = match members.get("op").and_then(Value::as_str) {
        Some("thread.add") => ADD_FIELDS,
        Some("message.add") => REPLY_FIELDS,
        Some("thread.resolve") => RESOLVE_FIELDS,
        _ => return vec![at(&joined(path, "op"), OP_KINDS)],
    };
    fields::single(object_issues(path, fields, members))
}

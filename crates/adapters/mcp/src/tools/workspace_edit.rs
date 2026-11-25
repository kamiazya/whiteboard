//! `wb_workspace_edit` over `whiteboard-ops`'s `WorkspaceEdit`: its input
//! judged as the SDK judges it, one fault to an op, in the words the
//! recording holds; the workspace address handed to the operation as the
//! caller typed it, since the tool words its own refusal of an unknown one;
//! and what the operation leaves pending answered as a pending tool.

use serde_json::{Map, Value};
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ops::{
    AppliedOp, WorkspaceEdit, WorkspaceEditAnswer, WorkspaceEditInput, WorkspaceOp, is_js_space,
};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{
    Checked, Field, Input, Kind, Refined, at, characters, expected, joined, object_issues,
    path_issues,
};
use super::json::Json;
use super::thread_edit::{AUTHOR, UNJUDGED};
use super::version_restore::path_segments;

/// `OPS_PER_CALL_MAX`, `DOCUMENT_PATH_MAX_LENGTH`, `DOCUMENT_NAME_MAX_LENGTH`
/// and `MARKDOWN_MAX_CHARS`.
const OPS_MAX: usize = 200;
const PATH_MAX: usize = 1024;
const NAME_MAX: usize = 200;
const MARKDOWN_MAX: usize = 256 * 1024;

const NO_OPS: &str = "Too small: expected array to have >=1 items";
const TOO_MANY_OPS: &str =
    "more ops than the 200-op limit for one call; split the batch across calls";
const OP_KINDS: &str = "Invalid discriminator value. Expected 'document.create' | 'document.set' | 'document.move' | 'document.delete' | 'folder.rename'";
const CREATE_KINDS: &str = "Invalid discriminator value. Expected 'markdown' | 'spatial'";
const NAME_TOO_LONG: &str = "a display name is at most 200 characters";
const MARKDOWN_TOO_LONG: &str = "markdown is longer than the 262144-character limit for one document; split the content across documents";

const SEGMENTS: Refined = Refined {
    test: path_segments,
    message: "each segment must be non-empty and contain only ASCII letters, digits and interior hyphens",
};

impl Binding for WorkspaceEdit {
    const NAME: &str = "wb_workspace_edit";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_workspace_edit.json");
    const INPUT: Input = Input {
        fields: &[
            WORKSPACE_ADDRESS,
            Field { name: "createWorkspace", kind: Kind::Flag },
            Field { name: "actor", kind: Kind::Checked(AUTHOR) },
            Field {
                name: "ops",
                kind: Kind::Checked(Checked { issues: ops_issues, aborts: None }),
            },
        ],
        refine: None,
    };
    const RESOLVES_ITS_WORKSPACE: bool = true;

    fn input(arguments: &Map<String, Value>, _: Option<String>) -> WorkspaceEditInput {
        let ops = arguments.get("ops").and_then(Value::as_array);
        WorkspaceEditInput {
            address: text(arguments.get("workspaceId")).unwrap_or_default(),
            create_workspace: arguments.get("createWorkspace") == Some(&Value::Bool(true)),
            ops: ops.map(|ops| ops.iter().map(op_of).collect()).unwrap_or_default(),
        }
    }

    fn output(answer: &WorkspaceEditAnswer) -> Option<Json> {
        let WorkspaceEditAnswer::Edited(edited) = answer else { return None };
        let results = edited.results.iter().map(row).collect::<Vec<_>>();
        Some(Json::Object(vec![
            ("workspaceId", Json::Text(edited.workspace_id.clone())),
            ("applied", Json::Number(count(results.len()))),
            ("results", Json::List(results)),
        ]))
    }

    fn unjudged(refusal: &str) -> bool {
        refusal.contains(UNJUDGED)
    }
}

/// A batch is far below 2^32 ops, so its count is an exact double.
fn count(n: usize) -> f64 {
    f64::from(u32::try_from(n).unwrap_or(u32::MAX))
}

fn row(applied: &AppliedOp) -> Json {
    let mut members = vec![("op", Json::Text(applied.op.to_owned()))];
    if let Some(document_id) = &applied.document_id {
        members.push(("documentId", Json::Text(document_id.clone())));
    }
    members.push(("path", Json::Text(applied.path.clone())));
    Json::Object(members)
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// An op the SDK has judged, as the operation tells them apart.
fn op_of(op: &Value) -> WorkspaceOp {
    let member = |key: &str| text(op.get(key));
    let document_id = || member("documentId").unwrap_or_default();
    match op.get("op").and_then(Value::as_str) {
        Some("document.create") if op.get("kind") == Some(&Value::from("spatial")) => {
            WorkspaceOp::CreateSpatial {
                path: member("path").unwrap_or_default(),
                name: member("name"),
            }
        }
        Some("document.create") => WorkspaceOp::CreateMarkdown,
        Some("document.move") => WorkspaceOp::Move {
            document_id: document_id(),
            path: member("path"),
            name: member("name"),
        },
        Some("document.delete") => WorkspaceOp::Delete { document_id: document_id() },
        Some("folder.rename") => WorkspaceOp::FolderRename {
            path: member("path").unwrap_or_default(),
            name: member("name"),
        },
        _ => WorkspaceOp::Set,
    }
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
        // A string or an object carrying a length is judged for it too, in
        // words no call recorded past the bounds.
        Some(Value::String(held)) if !within_ops(characters(held)) => vec![UNJUDGED.to_owned()],
        Some(held) if !length_within(held, 1..=OPS_MAX) => vec![UNJUDGED.to_owned()],
        other => vec![expected(path, "array", other)],
    }
}

/// Whether a batch of `length` ops is within the bounds.
fn within_ops(length: usize) -> bool {
    (1..=OPS_MAX).contains(&length)
}

/// A discriminator, judged before the arm it picks.
const PICKED: Kind = Kind::Checked(Checked { issues: |_, _| Vec::new(), aborts: None });
const OP: Field = Field { name: "op", kind: PICKED };
const KIND: Field = Field { name: "kind", kind: PICKED };

const DOCUMENT_ID: Field = Field {
    name: "documentId",
    kind: Kind::Text(Refined { test: canonical_ulid, message: "must be a canonical ULID" }),
};
const PATH: Field = Field {
    name: "path",
    kind: Kind::Checked(Checked {
        issues: |path, value| match value {
            None => vec![expected(path, "string", None)],
            Some(_) => path_issues(path, PATH_MAX, &SEGMENTS, value),
        },
        aborts: None,
    }),
};
const NAME: Field =
    Field { name: "name", kind: Kind::Checked(Checked { issues: name_issues, aborts: None }) };

const CREATE_MARKDOWN: &[Field] = &[
    OP,
    PATH,
    KIND,
    NAME,
    Field {
        name: "markdown",
        kind: Kind::Checked(Checked { issues: markdown_issues, aborts: None }),
    },
];
const CREATE_SPATIAL: &[Field] = &[OP, PATH, KIND, NAME];
const SET: &[Field] = &[
    OP,
    DOCUMENT_ID,
    Field {
        name: "markdown",
        kind: Kind::Checked(Checked {
            issues: |path, value| match value {
                None => vec![expected(path, "string", None)],
                Some(_) => markdown_issues(path, value),
            },
            aborts: None,
        }),
    },
];
const MOVE: &[Field] = &[
    OP,
    DOCUMENT_ID,
    Field { name: "path", kind: Kind::Path { max: PATH_MAX, segments: SEGMENTS } },
    NAME,
];
const DELETE: &[Field] = &[OP, DOCUMENT_ID];
const FOLDER: &[Field] = &[
    OP,
    PATH,
    Field {
        name: "name",
        kind: Kind::Checked(Checked { issues: folder_name_issues, aborts: None }),
    },
];

/// One op: an object whose `op` names an arm (a create's `kind` naming its
/// own), held to that arm's members, every fault in the arm's order.
fn op_issues(path: &str, op: &Value) -> Vec<String> {
    let Value::Object(members) = op else { return vec![expected(path, "object", Some(op))] };
    let fields = match members.get("op").and_then(Value::as_str) {
        Some("document.create") => match members.get("kind").and_then(Value::as_str) {
            Some("markdown") => CREATE_MARKDOWN,
            Some("spatial") => CREATE_SPATIAL,
            _ => return vec![at(&joined(path, "kind"), CREATE_KINDS)],
        },
        Some("document.set") => SET,
        Some("document.move") => MOVE,
        Some("document.delete") => DELETE,
        Some("folder.rename") => FOLDER,
        _ => return vec![at(&joined(path, "op"), OP_KINDS)],
    };
    object_issues(path, fields, members)
}

/// An optional string held to `max` characters and UTF-16 units, refused past
/// either in `too_long`.
fn bounded(path: &str, value: Option<&Value>, max: usize, too_long: &str) -> Vec<String> {
    match value {
        // Past `max` UTF-16 units: a string past `max` characters is past it
        // too, and Zod words both alike.
        Some(Value::String(held)) if held.encode_utf16().count() > max => vec![at(path, too_long)],
        None | Some(Value::String(_)) => Vec::new(),
        // A list or an object carrying a length is judged for it as well,
        // in words no call recorded past the bound.
        Some(held) if !length_within(held, 0..=max) => vec![UNJUDGED.to_owned()],
        other => vec![expected(path, "string", other)],
    }
}

/// Whether the length a value that is no string carries (a list's, or an
/// object's `length` member) is within `bounds`; one carrying none is.
fn length_within(value: &Value, bounds: std::ops::RangeInclusive<usize>) -> bool {
    match value {
        Value::Array(items) => bounds.contains(&items.len()),
        Value::Object(held) => held.get("length").is_none_or(|length| {
            length
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .is_some_and(|n| bounds.contains(&n))
        }),
        _ => true,
    }
}

/// A display name: `documentNameSchema`.
fn name_issues(path: &str, value: Option<&Value>) -> Vec<String> {
    bounded(path, value, NAME_MAX, NAME_TOO_LONG)
}

/// A body: `markdownInputSchema`.
fn markdown_issues(path: &str, value: Option<&Value>) -> Vec<String> {
    bounded(path, value, MARKDOWN_MAX, MARKDOWN_TOO_LONG)
}

/// A folder's name: `folderNameSchema`, any string `folderNameRefusal` lets
/// through.
fn folder_name_issues(path: &str, value: Option<&Value>) -> Vec<String> {
    match value {
        None => Vec::new(),
        Some(Value::String(name)) => {
            folder_name_refusal(name).map(|why| at(path, why)).into_iter().collect()
        }
        other => vec![expected(path, "string", other)],
    }
}

/// `folderNameRefusal`: blank, holding a `/`, or past the name bound, each
/// judged on the name as JavaScript's `trim` leaves it.
fn folder_name_refusal(name: &str) -> Option<&'static str> {
    let trimmed = name.trim_matches(is_js_space);
    if trimmed.is_empty() {
        Some("A folder name cannot be blank.")
    } else if trimmed.contains('/') {
        Some("A folder name cannot contain \"/\", which separates folders in a path.")
    } else if trimmed.encode_utf16().count() > NAME_MAX {
        Some("A folder name is at most 200 characters.")
    } else {
        None
    }
}

#[cfg(test)]
mod tests;

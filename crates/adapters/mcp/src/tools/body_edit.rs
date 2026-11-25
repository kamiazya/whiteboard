//! `wb_body_edit` over `whiteboard-ops`'s `BodyEdit`: its input judged as the
//! SDK judges it, every refusal answered, and what the operation leaves
//! pending answered as a pending tool.
//!
//! Every fault the SDK words in this tool's input is held to the recording,
//! the values that are no string or no array included, so no input is left
//! pending.

mod fields;

use serde_json::{Map, Value};
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ops::{
    BodyEdit, BodyEditAnswer, BodyEditInput, BodyEditMode, BodyReplace, MAX_PASSAGES,
};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::object_issues;
use super::input::{Checked, Field, Input, Kind, Refined, at, characters, expected, joined};
use super::json::Json;

const NO_OPS: &str = "a body edit carries at least one passage";
const TOO_MANY_OPS: &str =
    "more passages than the 200-op limit for one call; split the batch across calls";

impl Binding for BodyEdit {
    const NAME: &str = "wb_body_edit";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_body_edit.json");
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
            Field { name: "mode", kind: Kind::Choice(&["apply", "propose"]) },
            Field { name: "proposalId", kind: Kind::Checked(fields::PROPOSAL_ID) },
            Field { name: "author", kind: Kind::Checked(fields::AUTHOR) },
            Field {
                name: "ops",
                kind: Kind::Checked(Checked { issues: ops_issues, aborts: None }),
            },
        ],
        refine: None,
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> BodyEditInput {
        let ops = arguments.get("ops").and_then(Value::as_array);
        BodyEditInput {
            workspace_id: workspace_id.unwrap_or_default(),
            document_id: text(arguments.get("documentId")).unwrap_or_default(),
            mode: match arguments.get("mode").and_then(Value::as_str) {
                Some("apply") => Some(BodyEditMode::Apply),
                Some(_) => Some(BodyEditMode::Propose),
                None => None,
            },
            proposal_id: text(arguments.get("proposalId")),
            author: text(arguments.get("author")),
            ops: ops.map(|ops| ops.iter().filter_map(op_of).collect()).unwrap_or_default(),
        }
    }

    fn output(answer: &BodyEditAnswer) -> Option<Json> {
        let BodyEditAnswer::Edited(edited) = answer else { return None };
        let mut members = vec![
            ("documentId", Json::Text(edited.document_id.clone())),
            ("applied", Json::Number(f64::from(u32::try_from(edited.applied).unwrap_or(u32::MAX)))),
        ];
        if let Some(proposal) = &edited.proposed {
            members.push(("proposed", Json::Plain(proposal.clone())));
        }
        members.push(("body", Json::Text(edited.body.clone())));
        Some(Json::Object(members))
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// One op as the operation reads it, a member the judgement has passed.
fn op_of(op: &Value) -> Option<BodyReplace> {
    let anchor = op.get("anchor")?;
    let quote = anchor.get("quote")?;
    Some(BodyReplace {
        id: text(op.get("id"))?,
        node_id: text(anchor.get("nodeId")),
        prefix: text(quote.get("prefix")),
        exact: text(quote.get("exact"))?,
        suffix: text(quote.get("suffix")),
        start: anchor.get("start")?.as_f64()?,
        end: anchor.get("end")?.as_f64()?,
        text: text(op.get("text"))?,
        assumed: text(op.get("assumed"))?,
    })
}

/// `ops`: an array of one to 200 passages, each judged in turn; an array past
/// the bounds is refused for its length alone, before any item. A string is no
/// array, and Zod still judges the length it has.
fn ops_issues(path: &str, value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(ops)) if ops.is_empty() => vec![at(path, NO_OPS)],
        Some(Value::Array(ops)) if ops.len() > MAX_PASSAGES => vec![at(path, TOO_MANY_OPS)],
        Some(Value::Array(ops)) => ops
            .iter()
            .enumerate()
            .flat_map(|(position, op)| op_issues(&joined(path, &position.to_string()), op))
            .collect(),
        Some(Value::String(held)) => {
            let words = match characters(held) {
                0 => Some(NO_OPS),
                1..=MAX_PASSAGES => None,
                _ => Some(TOO_MANY_OPS),
            };
            std::iter::once(expected(path, "array", value))
                .chain(words.map(|words| at(path, words)))
                .collect()
        }
        other => vec![expected(path, "array", other)],
    }
}

const OP_FIELDS: &[Field] = &[
    Field { name: "id", kind: Kind::Checked(fields::CHANGE_ID) },
    Field { name: "op", kind: Kind::Checked(fields::OP_NAME) },
    Field { name: "anchor", kind: Kind::Checked(fields::ANCHOR) },
    Field { name: "text", kind: Kind::Checked(fields::TEXT) },
    Field { name: "assumed", kind: Kind::Checked(fields::ASSUMED) },
];

fn op_issues(path: &str, op: &Value) -> Vec<String> {
    match op {
        Value::Object(members) => object_issues(path, OP_FIELDS, members),
        _ => vec![expected(path, "object", Some(op))],
    }
}

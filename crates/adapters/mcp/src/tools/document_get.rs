//! `wb_document_get` over `whiteboard-ops`'s `DocumentGet`.

use serde_json::{Map, Value};
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ops::{DocumentGet, DocumentGetAnswer, DocumentGetInput, FailedRead, ReadDocument};

use super::Binding;
use super::document_list::WORKSPACE_ADDRESS;
use super::input::{Field, Input, Kind, Refined};
use super::json::Json;

/// `MAX_DOCUMENTS`: a judgement on one request, since each document's content
/// is untruncated.
const MAX_DOCUMENTS: usize = 20;

impl Binding for DocumentGet {
    const NAME: &str = "wb_document_get";
    const CONTRACT: &str = include_str!("../../../../../contracts/tools/wb_document_get.json");
    const INPUT: Input = Input {
        fields: &[
            WORKSPACE_ADDRESS,
            Field {
                name: "documentIds",
                kind: Kind::List {
                    min: 1,
                    max: MAX_DOCUMENTS,
                    item: Refined { test: canonical_ulid, message: "must be a canonical ULID" },
                },
            },
            Field {
                name: "options",
                kind: Kind::Object(&[Field { name: "strict", kind: Kind::Flag }]),
            },
        ],
        refine: None,
    };

    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> DocumentGetInput {
        let workspace_id = workspace_id.unwrap_or_default();
        let document_ids = arguments
            .get("documentIds")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        let strict = arguments
            .get("options")
            .and_then(|options| options.get("strict"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        DocumentGetInput { workspace_id, document_ids, strict }
    }

    fn output(answer: &DocumentGetAnswer) -> Option<Json> {
        let DocumentGetAnswer::Read(output) = answer else { return None };
        Some(Json::Object(vec![
            ("documents", Json::List(output.documents.iter().map(document).collect())),
            ("failed", Json::List(output.failed.iter().map(failure).collect())),
        ]))
    }
}

/// A read document's members in the order `readOne` builds them, an absent
/// one and an empty annotation list left out.
fn document(read: &ReadDocument) -> Json {
    let mut members = vec![
        ("documentId", Json::Text(read.document_id.clone())),
        ("kind", Json::Text(read.kind.clone())),
        ("content", Json::Text(read.content.clone())),
    ];
    if let Some(frontmatter) = &read.frontmatter {
        members.push(("frontmatter", Json::Plain(frontmatter.clone())));
    }
    for (key, items) in [("threads", &read.threads), ("proposals", &read.proposals)] {
        if !items.is_empty() {
            members.push((key, Json::Plain(whiteboard_model::Value::Seq(items.clone()))));
        }
    }
    if read.annotations_truncated {
        members.push(("annotationsTruncated", Json::Bool(true)));
    }
    Json::Object(members)
}

fn failure(failed: &FailedRead) -> Json {
    Json::Object(vec![
        ("documentId", Json::Text(failed.document_id.clone())),
        ("reason", Json::Text(failed.reason.clone())),
    ])
}

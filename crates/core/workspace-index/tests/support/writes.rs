//! The recorded writes over a workspace record's bytes, replayed by the Rust
//! index in the recorder's shape: the answer, what the keeper stored (the
//! record's deep value with container ids, and its version vector), how many
//! times it saved, and which blobs were left.

use super::{entry_json, ok, refusal};
use serde_json::{Value as Json, json};
use std::collections::BTreeMap;
use whiteboard_crdt::{deep_value_with_id, version_pairs};
use whiteboard_model::Value;
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_workspace_index::{
    BlobRef, CreateDocument, DeleteDocument, IndexError, MoveDocument, PlacedDocument,
    PurgeTrashEntry, RestoreDocument, SetDocumentName, SetDocumentPinned, SetFolderName,
    TrashBlobs, WorkspaceRecord, create_document, delete_document, move_document,
    purge_trash_entry, restore_document, set_document_name_of, set_document_pinned,
    set_folder_name_of,
};

/// The clock the recorder pins `Date.now` to.
const RECORDED_NOW: f64 = 1_700_000_000_000.0;

/// The peer the recorder's lease writes as.
const PEER: u64 = 1;

/// What one replayed write left behind.
pub(crate) struct Replayed {
    pub(crate) result: Json,
    pub(crate) deep: Option<Json>,
    pub(crate) vv: Json,
    pub(crate) saves: usize,
    pub(crate) blobs: Vec<String>,
    pub(crate) minted: usize,
}

/// A recorded value as JSON: a whole number is an integer, as the recorder wrote it.
fn json_of(value: &Value) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Bool(b) => Json::from(*b),
        Value::Number(n) => whole(*n).map_or_else(|| Json::from(*n), Json::from),
        Value::String(s) => Json::from(s.as_str()),
        Value::BigInt(digits) => Json::from(digits.as_str()),
        Value::Seq(items) => Json::Array(items.iter().map(json_of).collect()),
        Value::Map(entries) => {
            Json::Object(entries.iter().map(|(k, v)| (k.clone(), json_of(v))).collect())
        }
    }
}

fn whole(n: f64) -> Option<i64> {
    (n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0)
        .then(|| n.to_string().parse().ok())
        .flatten()
}

/// What `answer` makes of a refusal, in the recorder's shape.
fn refused(error: &IndexError) -> Json {
    match error {
        IndexError::InvalidInput => json!({ "err": "ZodError" }),
        IndexError::DocumentNotFound { workspace_id, target } => refusal(
            "DocumentNotFoundError",
            json!({ "workspaceId": workspace_id, "target": target }),
        ),
        IndexError::PathTaken { workspace_id, path } => {
            refusal("DocumentPathTakenError", json!({ "workspaceId": workspace_id, "path": path }))
        }
        IndexError::PathContested { workspace_id, path } => refusal(
            "DocumentPathContestedError",
            json!({ "workspaceId": workspace_id, "path": path }),
        ),
        IndexError::MoveIntoSelf { from, to } => {
            refusal("DocumentMoveIntoSelfError", json!({ "from": from, "to": to }))
        }
        IndexError::HasDescendants { path, .. } => {
            refusal("DocumentHasDescendantsError", json!({ "path": path }))
        }
        IndexError::DisplayNameTaken(taken) => refusal(
            "DisplayNameTakenError",
            json!({
                "kind": if taken.kind == whiteboard_workspace_index::NamedKind::Folder { "folder" } else { "document" },
                "path": taken.path,
                "displayName": taken.display_name,
            }),
        ),
        IndexError::UnreadableTrashBytes(_) => json!({ "err": "string" }),
        other => json!({ "err": format!("{other:?}") }),
    }
}

/// The blobs a row holds before the call, keyed by digest, and the counter the
/// recorder's store draws new digests from.
pub(crate) struct Blobs {
    pub(crate) held: BTreeMap<String, Vec<u8>>,
    next: u64,
}

impl Blobs {
    fn of(row: &Json) -> Self {
        let held = row["blobs"]
            .as_array()
            .map(|blobs| {
                blobs
                    .iter()
                    .map(|blob| {
                        let bytes = base64_to_bytes(blob["bytes"].as_str().unwrap_or_default());
                        (
                            blob["digestHex"].as_str().unwrap_or_default().to_owned(),
                            bytes.unwrap_or_default(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self { held, next: 0 }
    }
}

impl TrashBlobs for Blobs {
    fn put(&mut self, bytes: Vec<u8>) -> BlobRef {
        let digest_hex = loop {
            self.next += 1;
            let digest = format!("{:064}", self.next);
            if !self.held.contains_key(&digest) {
                break digest;
            }
        };
        self.held.insert(digest_hex.clone(), bytes);
        BlobRef { algorithm: "sha-256".to_owned(), digest_hex }
    }

    fn get(&self, blob: &BlobRef) -> Option<Vec<u8>> {
        self.held.get(&blob.digest_hex).cloned()
    }

    fn delete(&mut self, blob: &BlobRef) {
        self.held.remove(&blob.digest_hex);
    }
}

/// A restored document as the record stores it, in the recorder's shape.
fn placed_json(placed: &PlacedDocument) -> Json {
    let meta = &placed.meta;
    let mut out = json!({
        "documentId": meta.document_id,
        "segment": meta.segment,
        "kind": meta.kind,
        "path": placed.path,
        "contentDigest": placed.content_digest,
    });
    for (key, value) in [
        ("name", meta.name.clone().map(Json::from)),
        ("nameChosen", meta.name_chosen.then(|| Json::from(true))),
        ("createdAt", meta.created_at.map(|n| json_of(&Value::Number(n)))),
        ("updatedAt", meta.updated_at.map(|n| json_of(&Value::Number(n)))),
    ] {
        if let (Some(value), Some(fields)) = (value, out.as_object_mut()) {
            fields.insert(key.to_owned(), value);
        }
    }
    out
}

type Done = Result<(Json, bool), IndexError>;

fn text(args: &Json, key: &str) -> String {
    args[key].as_str().unwrap_or_default().to_owned()
}

/// The write the row's op names, over the record, or `None` for an op not ported.
fn run(
    op: &str,
    record: &WorkspaceRecord,
    args: &Json,
    mint: &mut dyn FnMut() -> String,
    blobs: &mut Blobs,
) -> Option<Done> {
    let workspace_id = text(args, "workspaceId");
    let name = args["name"].as_str();
    Some(match op {
        "createDocument" => {
            let input = CreateDocument {
                workspace_id: &workspace_id,
                path: &text(args, "path"),
                kind: &text(args, "kind"),
                name,
            };
            create_document(record, &input, mint, RECORDED_NOW)
                .map(|done| (entry_json(&done.value), done.saved))
        }
        "moveDocument" => {
            let input = MoveDocument {
                workspace_id: &workspace_id,
                from: &text(args, "from"),
                to: &text(args, "to"),
            };
            move_document(record, &input).map(|done| (Json::Null, done.saved))
        }
        "setDocumentName" => {
            let input = SetDocumentName {
                workspace_id: &workspace_id,
                document_id: &text(args, "documentId"),
                name,
            };
            set_document_name_of(record, &input).map(|done| (Json::Null, done.saved))
        }
        "setDocumentPinned" => {
            let input = SetDocumentPinned {
                workspace_id: &workspace_id,
                document_id: &text(args, "documentId"),
                pinned: args["pinned"].as_bool().unwrap_or_default(),
            };
            set_document_pinned(record, &input).map(|done| (Json::Null, done.saved))
        }
        "setFolderName" => {
            let input =
                SetFolderName { workspace_id: &workspace_id, path: &text(args, "path"), name };
            set_folder_name_of(record, &input).map(|done| (Json::Null, done.saved))
        }
        "deleteDocument" => {
            let input = DeleteDocument { workspace_id: &workspace_id, path: &text(args, "path") };
            delete_document(record, &input, blobs, RECORDED_NOW)
                .map(|done| (Json::Null, done.saved))
        }
        "purgeTrashEntry" => {
            let input = PurgeTrashEntry {
                workspace_id: &workspace_id,
                document_id: &text(args, "documentId"),
            };
            purge_trash_entry(record, &input, blobs)
                .map(|done| (Json::from(done.value), done.saved))
        }
        "restoreDocument" => {
            let input = RestoreDocument {
                workspace_id: &workspace_id,
                document_id: &text(args, "documentId"),
            };
            restore_document(record, &input, blobs)
                .map(|done| (done.value.as_ref().map_or(Json::Null, placed_json), done.saved))
        }
        _ => return None,
    })
}

/// The row replayed, or `None` for an op the Rust index does not write yet.
pub(crate) fn write_answer(row: &Json) -> Option<Replayed> {
    let op = row["op"].as_str()?;
    let args = &row["args"];
    let mut blobs = Blobs::of(row);
    let Some(before) = row["before"].as_str() else {
        return Some(Replayed {
            result: refusal(
                "WorkspaceNotFoundError",
                json!({ "workspaceId": args["workspaceId"] }),
            ),
            deep: None,
            vv: json!([]),
            saves: 0,
            blobs: blobs.held.keys().cloned().collect(),
            minted: 0,
        });
    };
    let record = WorkspaceRecord::open_as(&base64_to_bytes(before)?, PEER).ok()?;
    let mut queue: Vec<String> = row["mint"]
        .as_array()
        .map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect())
        .unwrap_or_default();
    queue.reverse();
    let mut minted = 0_usize;
    let mut mint = || {
        minted += 1;
        queue.pop().unwrap_or_default()
    };
    let done = run(op, &record, args, &mut mint, &mut blobs)?;
    let saves = usize::from(done.as_ref().is_ok_and(|(_, saved)| *saved));
    let result = done.map_or_else(|error| refused(&error), |(value, _)| ok(value));
    let vv = version_pairs(record.doc());
    Some(Replayed {
        result,
        deep: (saves > 0).then(|| json_of(&deep_value_with_id(record.doc()))),
        vv: json!(vv.iter().map(|(peer, counter)| json!([peer, counter])).collect::<Vec<_>>()),
        saves,
        blobs: blobs.held.keys().cloned().collect(),
        minted,
    })
}

//! The recorded rows over a workspace record's bytes, answered by the Rust
//! reads in the recorder's answer shape.

mod writes;

use serde_json::{Value as Json, json};
use whiteboard_model::encoding::base64_to_bytes;
use whiteboard_workspace_index::{
    DocumentEntry, ReadError, TrashRow, WorkspaceRecord, list_documents, list_folder_names,
    list_pinned_documents, list_trash, resolve_document, resolve_document_by_id,
    restorable_trash_documents,
};
pub(crate) use writes::write_answer;

pub(crate) fn ok(value: impl Into<Json>) -> Json {
    json!({ "ok": value.into() })
}

/// An entry in the recorder's shape; absent fields stay absent.
pub(crate) fn entry_json(entry: &DocumentEntry) -> Json {
    let mut out = json!({
        "documentId": entry.document_id,
        "path": entry.path,
        "contentDigest": entry.content_digest,
    });
    for (key, value) in [
        ("kind", entry.kind.clone().map(Json::from)),
        ("name", entry.name.clone().map(Json::from)),
        ("shadowed", entry.shadowed.map(Json::from)),
        ("updatedAt", entry.updated_at.clone().map(Json::from)),
    ] {
        if let (Some(value), Some(fields)) = (value, out.as_object_mut()) {
            fields.insert(key.to_owned(), value);
        }
    }
    out
}

pub(crate) fn refusal(name: &str, fields: Json) -> Json {
    let mut fields = fields;
    if let Some(map) = fields.as_object_mut() {
        map.insert("name".to_owned(), json!(name));
    }
    json!({ "err": name, "fields": fields })
}

fn read_error(error: ReadError, args: &Json) -> Json {
    match error {
        ReadError::PathContested => refusal(
            "DocumentPathContestedError",
            json!({ "workspaceId": args["workspaceId"], "path": args["path"] }),
        ),
        ReadError::InvalidTime(_) => json!({ "err": "RangeError" }),
    }
}

fn trash_json(row: &TrashRow) -> Json {
    let mut out = json!({
        "documentId": row.document_id,
        "path": row.path,
        "deletedAt": row.deleted_at,
        "blob": { "algorithm": row.algorithm, "digestHex": row.digest_hex },
    });
    if let Some(fields) = out.as_object_mut() {
        if let Some(name) = &row.name {
            fields.insert("name".to_owned(), json!(name));
        }
        if let Some(names) = &row.folder_names {
            let names: Vec<Json> =
                names.iter().map(|(path, name)| json!({ "path": path, "name": name })).collect();
            fields.insert("folderNames".to_owned(), Json::Array(names));
        }
    }
    out
}

fn entries(result: Result<Vec<DocumentEntry>, ReadError>, args: &Json) -> Json {
    result.map_or_else(
        |error| read_error(error, args),
        |list| ok(list.iter().map(entry_json).collect::<Vec<_>>()),
    )
}

fn entry(result: Result<Option<DocumentEntry>, ReadError>, args: &Json) -> Json {
    result.map_or_else(
        |error| read_error(error, args),
        |found| ok(found.as_ref().map_or(Json::Null, entry_json)),
    )
}

/// The index read the row's op names, over the record its `before` holds.
fn index_answer(op: &str, record: &WorkspaceRecord, args: &Json) -> Option<Json> {
    let text = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
    Some(match op {
        "listDocuments" => entries(list_documents(record), args),
        "resolveDocument" => entry(resolve_document(record, &text("path")), args),
        "resolveDocumentById" => entry(
            resolve_document_by_id(record, &text("documentId")).map_err(ReadError::InvalidTime),
            args,
        ),
        "listPinnedDocuments" => ok(list_pinned_documents(record)),
        "listFolderNames" => ok(list_folder_names(record)
            .iter()
            .map(|(path, name)| json!({ "path": path, "name": name }))
            .collect::<Vec<_>>()),
        "listTrash" => ok(list_trash(record).iter().map(trash_json).collect::<Vec<_>>()),
        _ => return None,
    })
}

/// A row whose input is a record's snapshot: the read over it, or the refusal
/// a workspace nobody holds gets.
pub(crate) fn record_answer(row: &Json) -> Option<Json> {
    let op = row["op"].as_str()?;
    if !matches!(
        op,
        "listDocuments"
            | "resolveDocument"
            | "resolveDocumentById"
            | "listPinnedDocuments"
            | "listFolderNames"
            | "listTrash"
    ) {
        return None;
    }
    let args = &row["args"];
    let Some(before) = row["before"].as_str() else {
        return Some(refusal(
            "WorkspaceNotFoundError",
            json!({ "workspaceId": args["workspaceId"] }),
        ));
    };
    let record = WorkspaceRecord::open(&base64_to_bytes(before)?).ok()?;
    index_answer(op, &record, args)
}

/// `restorableTrashDocuments`: judged on bytes that may not be a record at all.
pub(crate) fn restore_answer(row: &Json) -> Json {
    let bytes = base64_to_bytes(row["bytes"].as_str().unwrap_or_default()).unwrap_or_default();
    let document_id = row["documentId"].as_str().unwrap_or_default();
    match restorable_trash_documents(&bytes, document_id, row["parentPath"].as_str()) {
        Err(_) => json!({ "err": "string" }),
        Ok(placed) => ok(placed
            .map_or(Json::Null, |p| json!({ "documents": p.documents, "folders": p.folders }))),
    }
}

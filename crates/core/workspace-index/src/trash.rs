//! The trash a workspace record keeps: what it records about each document a
//! delete evacuated, in a map beside the tree. The bytes live in
//! content-addressed storage; only the row naming them is here.

use whiteboard_crdt::{ContainerKind, Entry, LoroDoc, peek};
use whiteboard_model::Value;
use whiteboard_model::checks::canonical_ulid;

/// Where a deleted document's evacuated bytes are recorded.
pub(crate) const WORKSPACE_TRASH_KEY: &str = "trash";

/// The most folder names one trash row keeps.
pub(crate) const TRASH_FOLDER_NAMES_MAX: usize = 256;

/// What the trash records about a document that was deleted.
#[derive(Debug, Clone, PartialEq)]
pub struct TrashRow {
    pub document_id: String,
    pub path: String,
    pub name: Option<String>,
    pub folder_names: Option<Vec<(String, String)>>,
    pub deleted_at: u64,
    pub algorithm: String,
    pub digest_hex: String,
}

fn text<'a>(entries: &'a [(String, Value)], key: &str) -> Option<&'a str> {
    match entries.iter().find(|(held, _)| held == key)?.1 {
        Value::String(ref text) => Some(text),
        _ => None,
    }
}

fn present<'a>(entries: &'a [(String, Value)], key: &str) -> Option<&'a Value> {
    entries.iter().find(|(held, _)| held == key).map(|(_, value)| value)
}

fn non_empty<'a>(entries: &'a [(String, Value)], key: &str) -> Option<&'a str> {
    text(entries, key).filter(|text| !text.is_empty())
}

/// `{ path: min(1), name: min(1) }`, a key this version does not know set aside.
fn folder_name(value: &Value) -> Option<(String, String)> {
    let Value::Map(entries) = value else { return None };
    Some((non_empty(entries, "path")?.to_owned(), non_empty(entries, "name")?.to_owned()))
}

fn folder_names(value: &Value) -> Option<Vec<(String, String)>> {
    let Value::Seq(items) = value else { return None };
    if items.len() > TRASH_FOLDER_NAMES_MAX {
        return None;
    }
    items.iter().map(folder_name).collect()
}

pub(crate) fn is_digest(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn blob(value: &Value) -> Option<(String, String)> {
    let Value::Map(entries) = value else { return None };
    let digest = text(entries, "digestHex").filter(|digest| is_digest(digest))?;
    (text(entries, "algorithm")? == "sha-256").then(|| ("sha-256".to_owned(), digest.to_owned()))
}

/// One row as the read schema takes it, or `None` for a damaged one.
fn row_of(value: &Value) -> Option<TrashRow> {
    let Value::Map(entries) = value else { return None };
    let document_id = text(entries, "documentId").filter(|id| canonical_ulid(id))?;
    let name = match present(entries, "name") {
        None => None,
        Some(_) => Some(non_empty(entries, "name")?.to_owned()),
    };
    let Some(&Value::Number(deleted_at)) = present(entries, "deletedAt") else { return None };
    // A non-negative safe integer: the display of a whole double below 2^53 is its digits.
    let deleted_at = (deleted_at <= 9_007_199_254_740_991.0)
        .then(|| deleted_at.to_string().parse::<u64>().ok())
        .flatten()?;
    let (algorithm, digest_hex) = blob(present(entries, "blob")?)?;
    Some(TrashRow {
        document_id: document_id.to_owned(),
        path: non_empty(entries, "path")?.to_owned(),
        name,
        folder_names: match present(entries, "folderNames") {
            None => None,
            Some(value) => Some(folder_names(value)?),
        },
        deleted_at,
        algorithm,
        digest_hex,
    })
}

/// What this workspace could still bring back, newest first. A damaged row is
/// skipped rather than hiding every other recoverable document behind it.
#[must_use]
pub fn read_trash_rows(doc: &LoroDoc) -> Vec<TrashRow> {
    let Some(Entry::Container { kind: ContainerKind::Map, value: Value::Map(rows) }) =
        peek(doc, WORKSPACE_TRASH_KEY)
    else {
        return Vec::new();
    };
    let mut out: Vec<TrashRow> = rows.iter().filter_map(|(_, row)| row_of(row)).collect();
    out.sort_by_key(|row| std::cmp::Reverse(row.deleted_at));
    out
}

#[cfg(test)]
mod tests;

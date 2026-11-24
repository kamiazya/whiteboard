//! `writeIntoRecord` for a restore in place: the past written as the
//! document's content at its node, then the name a note at a generated path
//! takes from its heading, through the engine's own writers and as one
//! replica, so the operations appended are the TypeScript's.

use whiteboard_crdt::{ExportMode, Fault, MoreWriters};
use whiteboard_model::Value;
use whiteboard_model::crdt::WriterName;
use whiteboard_model::encoding::bytes_to_base64;
use whiteboard_workspace_index::{WorkspaceRecord, WorkspaceWriters};

use super::{RestorePending, Stop};

/// What writing the past left: whether the CONTENT moved (the name may move
/// alone), and the operations to keep, none when nothing was written.
pub(super) struct Written {
    pub(super) changed: bool,
    pub(super) update: Option<Vec<u8>>,
}

fn args(entries: Vec<(&str, String)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), Value::String(v))).collect())
}

/// One writer applied and committed; a writer that declines or throws leaves
/// the restore pending, since no write was kept yet.
fn apply(
    writers: &WorkspaceWriters,
    record: &WorkspaceRecord,
    op: WriterName,
    args: &Value,
) -> Result<(), Stop> {
    let step = writers.apply(record.doc(), op, args);
    record.doc().commit();
    match step {
        Some(Ok(())) => Ok(()),
        Some(Err(Fault::Declined)) => Err(Stop::Pending(RestorePending::Declined)),
        Some(Err(Fault::Thrown(_))) | None => Err(Stop::Pending(RestorePending::Unreadable)),
    }
}

/// The past state `past` written into the record `record_bytes` hold, at the
/// node of `document_id`, as replica `peer` at `now_ms`.
pub(super) fn past_at_node(
    record_bytes: &[u8],
    peer: u64,
    document_id: &str,
    past: &[u8],
    now_ms: f64,
) -> Result<Written, Stop> {
    let record = WorkspaceRecord::open_as(record_bytes, peer)
        .map_err(|_| Stop::Pending(RestorePending::Unreadable))?;
    let writers = WorkspaceWriters { now_ms };
    let from = record.doc().oplog_vv();
    let content =
        args(vec![("documentId", document_id.to_owned()), ("source", bytes_to_base64(past))]);
    apply(&writers, &record, WriterName::WriteWorkspaceDocumentContent, &content)?;
    let changed = record.doc().oplog_vv() != from;
    let named = args(vec![("documentId", document_id.to_owned())]);
    apply(&writers, &record, WriterName::SeedNameFromTitle, &named)?;
    if record.doc().oplog_vv() == from {
        return Ok(Written { changed, update: None });
    }
    let update = record
        .doc()
        .export(ExportMode::updates(&from))
        .map_err(|_| Stop::Pending(RestorePending::Unreadable))?;
    Ok(Written { changed, update: Some(update) })
}

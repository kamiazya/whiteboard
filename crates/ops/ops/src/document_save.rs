//! A batch of document writes kept as the content a workspace record's node
//! holds, as a session's save keeps it.

use whiteboard_crdt::{
    ExportMode, Fault, LoroDoc, MoreWriters, NodeAt, WriteAnswer, project_node, write_batch,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Write, WriteJudge, WriterName};
use whiteboard_model::encoding::bytes_to_base64;
use whiteboard_workspace_index::node_meta::WORKSPACE_TREE_KEY;
use whiteboard_workspace_index::{WorkspaceRecord, WorkspaceWriters};

/// A write the content sync declines: one that changes more than one of a
/// document's roots, whose order the TypeScript takes from wasm32's hash
/// map, or one the engine does not answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Declined;

fn text_args(entries: Vec<(&str, String)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), Value::String(v))).collect())
}

/// The batch applied to the document as a copy of its own, then the copy
/// written back whole as the content of its node, which is what keeping a
/// session's save does: the operations appended are the ones the TypeScript's
/// appends. The operations to keep, none when nothing moved.
pub(crate) fn save_batch(
    record: &WorkspaceRecord,
    peer: u64,
    now_ms: f64,
    document_id: &str,
    batch: &[Write],
) -> Result<Option<Vec<u8>>, Declined> {
    let declined = || Declined;
    let node = record.document_node(document_id).ok_or_else(declined)?.id;
    let at = NodeAt { doc: record.doc(), tree: WORKSPACE_TREE_KEY, node };
    let copy: LoroDoc = project_node(at).map_err(|_| declined())?;
    let before = copy.export(ExportMode::Snapshot).map_err(|_| declined())?;
    let written = write_batch(&before, peer, batch, WriteJudge::None).ok_or_else(declined)?;
    if matches!(written.answer, WriteAnswer::Thrown(_)) {
        return Err(declined());
    }
    let source = written.doc.export(ExportMode::Snapshot).map_err(|_| declined())?;
    let from = record.doc().oplog_vv();
    let args = text_args(vec![
        ("documentId", document_id.to_owned()),
        ("source", bytes_to_base64(&source)),
    ]);
    let writers = WorkspaceWriters { now_ms };
    let step = writers.apply(record.doc(), WriterName::WriteDocumentContentAndName, &args);
    record.doc().commit();
    match step {
        Some(Ok(())) => {}
        Some(Err(Fault::Declined | Fault::Thrown(_))) | None => return Err(declined()),
    }
    if record.doc().oplog_vv() == from {
        return Ok(None);
    }
    record.doc().export(ExportMode::updates(&from)).map(Some).map_err(|_| declined())
}

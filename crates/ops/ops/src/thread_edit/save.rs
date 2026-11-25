//! The batch's writes made to a copy of the document, and that copy stored as
//! the content the document's node holds (`saveSnapshot` over a workspace
//! record): the copy is cut from the node, written as a replica of its own
//! (its operations are the copy's and never reach the record), and the record
//! then takes what differs, as one replica, stamped and named as a save does.

use whiteboard_api_contracts::Refusal;
use whiteboard_crdt::{
    ExportMode, Fault, MoreWriters, NodeAt, WriteAnswer, answer_content_query, project_node,
    write_batch,
};
use whiteboard_model::Value;
use whiteboard_model::crdt::{Query, QueryName, Write, WriteJudge, WriterName};
use whiteboard_model::encoding::bytes_to_base64;
use whiteboard_ports::{Clock, DocumentWritten, IdMint, WorkspaceRecordStore, WriteObserver};
use whiteboard_workspace_index::node_meta::WORKSPACE_TREE_KEY;
use whiteboard_workspace_index::{WorkspaceRecord, WorkspaceWriters};

use super::{Halt, ThreadEditPending};
use crate::Ports;

const UNDECIDED: Halt = Halt::Pending(ThreadEditPending::Undecided);

/// The writes applied and stored; every thread the document now holds.
pub(super) async fn store<P: Ports>(
    ports: &P,
    record_bytes: &[u8],
    record: &WorkspaceRecord,
    document: Located<'_>,
    hosted_kind: Option<&str>,
    writes: &[Write],
) -> Result<Vec<Value>, Halt> {
    let node = record.document_node(document.id).ok_or(UNDECIDED)?;
    let at = NodeAt { doc: record.doc(), tree: WORKSPACE_TREE_KEY, node: node.id };
    let copy = project_node(at).map_err(|_| UNDECIDED)?;
    let before = copy.export(ExportMode::Snapshot).map_err(|_| UNDECIDED)?;
    let peer = ports.mint().peer_id();
    let written = write_batch(&before, peer, writes, WriteJudge::None).ok_or(UNDECIDED)?;
    if !matches!(written.answer, WriteAnswer::Applied(_)) {
        return Err(UNDECIDED);
    }
    // The copy is read as the TypeScript's session reads it before it is
    // stored: a read registers the roots it asks for, and a root registered
    // is a root the node then holds, empty or not.
    let threads = threads_of(&written.doc, hosted_kind)?;
    let content = written.doc.export(ExportMode::Snapshot).map_err(|_| UNDECIDED)?;
    let update = into_record(record_bytes, peer, document.id, &content, ports.clock().now_ms())?;
    if let Some(update) = update {
        ports
            .records()
            .append(document.workspace_id, &update)
            .await
            .map_err(|e| Refusal::from(&e))?;
    }
    let told = DocumentWritten {
        workspace_id: document.workspace_id.to_owned(),
        document_id: document.id.to_owned(),
        path: document.path.to_owned(),
    };
    ports.observer().document_written(&told).await;
    Ok(threads)
}

/// Which document is written, and where it sits.
pub(super) struct Located<'a> {
    pub(super) workspace_id: &'a str,
    pub(super) id: &'a str,
    pub(super) path: &'a str,
}

fn args(entries: Vec<(&str, String)>) -> Value {
    Value::Map(entries.into_iter().map(|(k, v)| (k.to_owned(), Value::String(v))).collect())
}

/// `writeDocumentContentAndName` as one replica over the record: the
/// operations it appended, none when nothing changed.
fn into_record(
    record_bytes: &[u8],
    peer: u64,
    document_id: &str,
    content: &[u8],
    now_ms: f64,
) -> Result<Option<Vec<u8>>, Halt> {
    let record = WorkspaceRecord::open_as(record_bytes, peer).map_err(|_| UNDECIDED)?;
    let from = record.doc().oplog_vv();
    let source =
        args(vec![("documentId", document_id.to_owned()), ("source", bytes_to_base64(content))]);
    let step = WorkspaceWriters { now_ms }.apply(
        record.doc(),
        WriterName::WriteDocumentContentAndName,
        &source,
    );
    record.doc().commit();
    match step {
        Some(Ok(())) => {}
        Some(Err(Fault::Declined)) => return Err(Halt::Pending(ThreadEditPending::Declined)),
        Some(Err(Fault::Thrown(_))) | None => return Err(UNDECIDED),
    }
    if record.doc().oplog_vv() == from {
        return Ok(None);
    }
    record.doc().export(ExportMode::updates(&from)).map(Some).map_err(|_| UNDECIDED)
}

/// The reads a session makes of its copy, in the order it makes them, and the
/// threads the last answers: `annotationsOf` over the copy the batch wrote.
fn threads_of(copy: &whiteboard_crdt::LoroDoc, kind: Option<&str>) -> Result<Vec<Value>, Halt> {
    let ask = |query: QueryName, args: Option<Value>| {
        answer_content_query(copy, &Query { query, args }).ok_or(UNDECIDED)
    };
    let kind =
        kind.map(|kind| Value::Map(vec![("kind".to_owned(), Value::String(kind.to_owned()))]));
    ask(QueryName::DocumentContent, kind)?;
    ask(QueryName::ThreadMessageCounts, None)?;
    match ask(QueryName::Annotations, None)?.value {
        Value::Map(mut entries) => match entries.pop() {
            Some((key, Value::Seq(threads))) if key == "ok" => Ok(threads),
            _ => Err(UNDECIDED),
        },
        _ => Err(UNDECIDED),
    }
}

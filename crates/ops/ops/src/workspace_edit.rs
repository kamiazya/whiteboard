//! `wb_workspace_edit`: documents created, moved, renamed and deleted and
//! folders named in one call, as server-core's `createWorkspaceEditTool`
//! applies them.
//!
//! The ops run in order against the workspace record, and the first that
//! cannot be applied stops the batch: the ops before it stand (each document
//! is a separate CRDT and a batch across them is no transaction), so what
//! they wrote is stored and the refusal says how many there were. What the
//! batch writes is written to one copy of the record as one replica, and
//! that copy's new operations are stored once, when the batch stops.
//!
//! What is not answered yet is [`WorkspaceEditAnswer::Pending`], and a
//! batch that meets it stores nothing: a body (`document.set`, a markdown
//! create), a delete (which evacuates the document into a blob the ports do
//! not reach yet), a workspace the call would mint, a move whose references
//! other documents would follow, and a record or a write the engine leaves
//! to its caller.

mod apply;
mod create;
mod follow;
mod refused;

use whiteboard_api_contracts::Refusal;
use whiteboard_crdt::ExportMode;
use whiteboard_ports::{
    DocumentWritten, IdMint, WorkspaceLock, WorkspaceRecordStore, WriteObserver,
};
use whiteboard_workspace_index::WorkspaceRecord;

use crate::address::{in_callers_words, resolve_workspace, unknown_workspace_for};
use crate::{Contract, Operation, Ports, Row};

/// One op of a batch, as far as this crate tells them apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceOp {
    /// A spatial document created at `path`, named `name` when one is given.
    CreateSpatial { path: String, name: Option<String> },
    /// A markdown document created, with or without a body.
    CreateMarkdown,
    /// A document's body replaced.
    Set,
    /// A document moved to `path`, renamed to `name`, or both.
    Move { document_id: String, path: Option<String>, name: Option<String> },
    /// A document deleted.
    Delete { document_id: String },
    /// The folder at `path` named, or its name cleared.
    FolderRename { path: String, name: Option<String> },
}

impl WorkspaceOp {
    /// The op's discriminator, as a refusal names it.
    const fn name(&self) -> &'static str {
        match self {
            Self::CreateSpatial { .. } | Self::CreateMarkdown => "document.create",
            Self::Set => "document.set",
            Self::Move { .. } => "document.move",
            Self::Delete { .. } => "document.delete",
            Self::FolderRename { .. } => "folder.rename",
        }
    }
}

/// The workspace as the caller addressed it (the tool resolves it itself,
/// since its refusal of an unknown one depends on the batch), whether the
/// call may create it, and the ops, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEditInput {
    pub address: String,
    pub create_workspace: bool,
    pub ops: Vec<WorkspaceOp>,
}

/// One applied op: its discriminator, and the document and path it reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedOp {
    pub op: &'static str,
    pub document_id: Option<String>,
    pub path: Option<String>,
}

/// The workspace the batch applied to, as its canonical id, and one row per
/// applied op.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceEditOutput {
    pub workspace_id: String,
    pub results: Vec<AppliedOp>,
}

/// The call's answer, or the part of it this crate does not answer yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceEditAnswer {
    Edited(WorkspaceEditOutput),
    Pending,
}

/// `createWorkspaceEditTool`'s execute, which only `wb_workspace_edit` calls.
#[derive(Debug, Clone, Copy)]
pub struct WorkspaceEdit;

/// Why an op stops the batch.
enum Halt {
    Refused(Refusal),
    Pending,
}

impl From<Refusal> for Halt {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

/// The batch so far: the record's copy it writes to, and the documents whose
/// content it wrote, to be announced once stored.
struct Batch<'a> {
    workspace_id: &'a str,
    record: WorkspaceRecord,
    written: Vec<DocumentWritten>,
}

impl Operation for WorkspaceEdit {
    type Input = WorkspaceEditInput;
    type Output = WorkspaceEditAnswer;

    const ROW: Row = Row {
        name: "workspaceEdit",
        tool: Some("wb_workspace_edit"),
        route: None,
        input: Contract { schema: "workspaceEditInputSchema" },
        output: Contract { schema: "workspaceEditOutputSchema" },
    };

    async fn execute<P: Ports>(
        ports: &P,
        input: WorkspaceEditInput,
    ) -> Result<WorkspaceEditAnswer, Refusal> {
        let handle = input.address.as_str();
        let resolved = resolve_workspace(ports, handle).await.map_err(|e| Refusal::from(&e))?;
        let workspace_id = match resolved {
            Some(entry) => entry.workspace_id,
            // Minting a workspace writes the registry, which no port here does.
            None if input.create_workspace => return Ok(WorkspaceEditAnswer::Pending),
            None => {
                let creates = input.ops.iter().any(|op| {
                    matches!(op, WorkspaceOp::CreateSpatial { .. } | WorkspaceOp::CreateMarkdown)
                });
                return Err(unknown_workspace_for(ports, handle.to_owned(), creates).await);
            }
        };
        let _held = ports.lock().lock(&workspace_id).await;
        edit(ports, &workspace_id, &input.ops)
            .await
            .map_err(|refusal| in_callers_words(refusal, &workspace_id, handle))
    }
}

/// The ops applied in order, and what they wrote stored.
async fn edit<P: Ports>(
    ports: &P,
    workspace_id: &str,
    ops: &[WorkspaceOp],
) -> Result<WorkspaceEditAnswer, Refusal> {
    let Some(bytes) = ports.records().load(workspace_id).await.map_err(|e| Refusal::from(&e))?
    else {
        return Ok(WorkspaceEditAnswer::Pending);
    };
    let Ok(record) = WorkspaceRecord::open_as(&bytes, ports.mint().peer_id()) else {
        return Ok(WorkspaceEditAnswer::Pending);
    };
    let from = record.doc().oplog_vv();
    let mut batch = Batch { workspace_id, record, written: Vec::new() };
    let mut results = Vec::with_capacity(ops.len());
    for (index, op) in ops.iter().enumerate() {
        match apply::apply(ports, &mut batch, op) {
            Ok(applied) => results.push(applied),
            Err(Halt::Pending) => return Ok(WorkspaceEditAnswer::Pending),
            Err(Halt::Refused(refusal)) => {
                if !store(ports, &batch, &from).await? {
                    return Ok(WorkspaceEditAnswer::Pending);
                }
                return Err(Refusal::WorkspaceEditOpRefused {
                    op_index: count(index),
                    op: op.name().to_owned(),
                    applied: count(results.len()),
                    detail: sentence_without_stop(&refusal.message()).to_owned(),
                });
            }
        }
    }
    if !store(ports, &batch, &from).await? {
        return Ok(WorkspaceEditAnswer::Pending);
    }
    Ok(WorkspaceEditAnswer::Edited(WorkspaceEditOutput {
        workspace_id: workspace_id.to_owned(),
        results,
    }))
}

/// A batch is far below `u64::MAX` ops.
fn count(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(u64::MAX)
}

/// `describeThrown(cause).replace(/\.$/, '')`: one final full stop dropped, so
/// a refusal that reads as a sentence is not stopped twice.
fn sentence_without_stop(text: &str) -> &str {
    text.strip_suffix('.').unwrap_or(text)
}

/// What the batch wrote, appended to the stored record when it wrote
/// anything, and the documents whose content it wrote announced. `false`
/// when the copy's operations cannot be exported.
async fn store<P: Ports>(
    ports: &P,
    batch: &Batch<'_>,
    from: &whiteboard_crdt::VersionVector,
) -> Result<bool, Refusal> {
    let doc = batch.record.doc();
    doc.commit();
    if doc.oplog_vv() != *from {
        let Ok(update) = doc.export(ExportMode::updates(from)) else { return Ok(false) };
        ports.records().append(batch.workspace_id, &update).await.map_err(|e| Refusal::from(&e))?;
    }
    for written in &batch.written {
        ports.observer().document_written(written).await;
    }
    Ok(true)
}

#[cfg(test)]
mod tests;

//! `wb_body_edit`: passages of a markdown document's body replaced, as
//! server-core's `createBodyEditTool` writes them under one hold of the
//! workspace's write lock.
//!
//! The default is to PROPOSE: the passages are stored on the document's
//! proposals plane and the body is left as it was; `apply` writes the body.
//! Either way every passage is placed before anything is written, and one
//! that cannot be refuses the whole call, so nothing of it is kept.
//!
//! What is not answered yet is [`BodyEditPending`].

mod place;
mod proposal;

use whiteboard_api_contracts::Refusal;
use whiteboard_model::Value;
use whiteboard_model::crdt::{QueryName, Write, WriterName};
use whiteboard_ports::{
    Clock, DocumentWritten, IdMint, WorkspaceLock, WorkspaceRecordStore, WriteObserver,
};
use whiteboard_workspace_index::WorkspaceRecord;

use crate::document_get::Stop;
use crate::document_get::engine::{Fault, Hosted, defined};
use crate::document_resolve::resolve_in;
use crate::document_save::save_batch;
use crate::record::load_record;
use crate::{Contract, Operation, Ports, Row};
use place::Placed;

/// The passages a call may carry (`OPS_PER_CALL_MAX`): one request, bounded by
/// the cost of placing each.
pub const MAX_PASSAGES: usize = 200;

/// What the call does with the passages: change the body, or store them for a
/// person to decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyEditMode {
    Apply,
    Propose,
}

/// One passage as a caller sends it: where it believes the passage is, what it
/// says, what it becomes, and what the passage said when the caller wrote the
/// edit. Offsets are UTF-16 units.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyReplace {
    pub id: String,
    pub node_id: Option<String>,
    pub prefix: Option<String>,
    pub exact: String,
    pub suffix: Option<String>,
    pub start: f64,
    pub end: f64,
    pub text: String,
    pub assumed: String,
}

/// The workspace, already resolved to its canonical id, the document, and the
/// call's passages. An absent mode is `Propose`.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyEditInput {
    pub workspace_id: String,
    pub document_id: String,
    pub mode: Option<BodyEditMode>,
    pub proposal_id: Option<String>,
    pub author: Option<String>,
    pub ops: Vec<BodyReplace>,
}

/// What the document holds once the call is kept.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyEditOutput {
    pub document_id: String,
    /// How many passages the body now holds differently; zero when proposing.
    pub applied: u64,
    /// The proposal the passages went into, as the document stores it.
    pub proposed: Option<Value>,
    pub body: String,
}

/// What this crate does not answer yet, which a binding answers as a pending
/// tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyEditPending {
    /// A write the content sync declines: one that changes more than one of a
    /// document's roots, whose order the TypeScript takes from wasm32's hash
    /// map, or one the engine does not answer.
    Declined,
    /// A read the record leaves undecided.
    Undecided,
}

/// The call's answer, or the part of it this crate does not answer yet.
#[derive(Debug, Clone, PartialEq)]
pub enum BodyEditAnswer {
    Edited(BodyEditOutput),
    Pending(BodyEditPending),
}

/// `createBodyEditTool`'s execute, which only `wb_body_edit` calls.
#[derive(Debug, Clone, Copy)]
pub struct BodyEdit;

/// Why the call stops before it answers.
#[derive(Debug)]
enum Halt {
    Refused(Refusal),
    Pending(BodyEditPending),
}

impl From<Refusal> for Halt {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<&whiteboard_ports::PortError> for Halt {
    fn from(error: &whiteboard_ports::PortError) -> Self {
        Self::Refused(Refusal::from(error))
    }
}

impl From<Fault> for Halt {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Retired(found) => Self::Refused(Refusal::RetiredStoredShape { found }),
            Fault::Stop(Stop::Refused(refusal)) => Self::Refused(refusal),
            Fault::Stop(Stop::Pending(_)) => Self::Pending(BodyEditPending::Undecided),
        }
    }
}

const UNDECIDED: Halt = Halt::Pending(BodyEditPending::Undecided);

impl Operation for BodyEdit {
    type Input = BodyEditInput;
    type Output = BodyEditAnswer;

    const ROW: Row = Row {
        name: "bodyEdit",
        tool: Some("wb_body_edit"),
        route: None,
        input: Contract { schema: "bodyEditInputSchema" },
        output: Contract { schema: "bodyEditOutputSchema" },
    };

    async fn execute<P: Ports>(ports: &P, input: BodyEditInput) -> Result<BodyEditAnswer, Refusal> {
        let _held = ports.lock().lock(&input.workspace_id).await;
        match edit(ports, &input).await {
            Ok(output) => Ok(BodyEditAnswer::Edited(output)),
            Err(Halt::Refused(refusal)) => Err(refusal),
            Err(Halt::Pending(pending)) => Ok(BodyEditAnswer::Pending(pending)),
        }
    }
}

/// The document a call edits: where it is kept, read through its record.
struct Target<'a> {
    record: &'a WorkspaceRecord,
    document_id: &'a str,
}

impl Target<'_> {
    fn hosted(&self) -> Hosted<'_> {
        Hosted { record: self.record, document_id: self.document_id }
    }

    /// The document's kind: one that states none is left to write.
    fn refuse_unless_markdown(&self) -> Result<(), Halt> {
        let asked = self.hosted().read(QueryName::DocumentKind, &[])?;
        let Some(Value::String(kind)) = defined(asked) else { return Ok(()) };
        if kind == "markdown" {
            return Ok(());
        }
        Err(Refusal::DocumentKindMismatch {
            document_id: self.document_id.to_owned(),
            kind,
            detail: "wb_body_edit writes prose into a document body, which a spatial document does not have. Use wb_canvas_edit to change a text node.".to_owned(),
        }
        .into())
    }

    fn body(&self) -> Result<String, Halt> {
        match self.hosted().read(QueryName::MarkdownBody, &[])? {
            Value::String(body) => Ok(body),
            _ => Err(UNDECIDED),
        }
    }

    /// The proposals the document holds, each as the reader answers it.
    fn proposals(&self) -> Result<Vec<Value>, Halt> {
        match self.hosted().read(QueryName::Proposals, &[])? {
            Value::Seq(held) => Ok(held),
            _ => Err(UNDECIDED),
        }
    }
}

/// The call: the document found and read, the passages placed, the write
/// kept and told.
async fn edit<P: Ports>(ports: &P, input: &BodyEditInput) -> Result<BodyEditOutput, Halt> {
    let ws = input.workspace_id.as_str();
    let peer = ports.mint().peer_id();
    let (bytes, _) = load_record(ports.records(), ws).await.map_err(|e| Halt::from(&e))?;
    let record = WorkspaceRecord::open_as(&bytes, peer).map_err(|_| UNDECIDED)?;
    let entry = resolve_in(&record, ws, &input.document_id)?;
    let target = Target { record: &record, document_id: &input.document_id };
    target.refuse_unless_markdown()?;
    let body = target.body()?;
    let planned = if input.mode == Some(BodyEditMode::Apply) {
        plan_apply(input, &body)?
    } else {
        plan_proposal(ports, &target, input, &body)?
    };
    let update =
        save_batch(&record, peer, ports.clock().now_ms(), &input.document_id, &planned.batch)
            .map_err(|_| Halt::Pending(BodyEditPending::Declined))?;
    if let Some(update) = update {
        ports.records().append(ws, &update).await.map_err(|e| Halt::from(&e))?;
    }
    ports
        .observer()
        .document_written(&DocumentWritten {
            workspace_id: ws.to_owned(),
            document_id: input.document_id.clone(),
            path: entry.path,
        })
        .await;
    answer(&target, input, planned)
}

/// What the call writes, and what it answers beyond the document's id.
struct Planned {
    batch: Vec<Write>,
    applied: u64,
    /// The proposal the call stored, whose stored form is the answer.
    proposal_id: Option<String>,
    body: String,
}

/// The passages applied to the body: placed, disjoint, still reading what the
/// caller assumed, and within the body limit.
fn plan_apply(input: &BodyEditInput, body: &str) -> Result<Planned, Halt> {
    let units: Vec<u16> = body.encode_utf16().collect();
    let placed = place::place_all(&units, &input.ops, &[])?;
    place::refuse_overlap(&placed)?;
    place::refuse_stale(&placed, &units)?;
    let next = place::apply_disjoint(&units, &placed);
    place::refuse_growth(units.len(), &placed, next.len())?;
    let body = String::from_utf16_lossy(&next);
    let written = Value::Map(vec![("body".to_owned(), Value::String(body.clone()))]);
    Ok(Planned {
        batch: vec![Write { op: WriterName::WriteMarkdownBody, args: written }],
        applied: u64::try_from(placed.len()).unwrap_or(u64::MAX),
        proposal_id: None,
        body,
    })
}

/// The passages stored as a proposal beside what it already holds, the body
/// left as it was.
fn plan_proposal<P: Ports>(
    ports: &P,
    target: &Target<'_>,
    input: &BodyEditInput,
    body: &str,
) -> Result<Planned, Halt> {
    let units: Vec<u16> = body.encode_utf16().collect();
    let held = target.proposals()?;
    let continuing = input.proposal_id.as_deref().and_then(|id| proposal::find(&held, id));
    let taken = continuing.map(proposal::change_ids).unwrap_or_default();
    let placed = place::place_all(&units, &input.ops, &taken)?;
    let existing =
        continuing.map(|stored| place::place_existing(&units, stored)).unwrap_or_default();
    let all: Vec<Placed> = existing.into_iter().chain(placed.iter().cloned()).collect();
    place::refuse_overlap(&all)?;
    let after = place::apply_disjoint(&units, &all);
    place::refuse_growth(units.len(), &placed, after.len())?;
    let now = ports.clock().now_iso().map_err(|e| Halt::from(&e))?;
    let stored = proposal::Stored::of(input, continuing, &held, &now);
    let changes: Vec<Value> = placed.iter().map(Placed::change).collect();
    stored.refuse_growth(&held, &changes)?;
    Ok(Planned {
        batch: vec![stored.write(changes)],
        applied: 0,
        proposal_id: Some(stored.id),
        body: body.to_owned(),
    })
}

/// The call's answer: the proposal as the document now stores it, whole.
fn answer(
    target: &Target<'_>,
    input: &BodyEditInput,
    planned: Planned,
) -> Result<BodyEditOutput, Halt> {
    let proposed = match &planned.proposal_id {
        None => None,
        Some(id) => {
            let stored = target.proposals()?;
            Some(proposal::find(&stored, id).cloned().ok_or(UNDECIDED)?)
        }
    };
    Ok(BodyEditOutput {
        document_id: input.document_id.clone(),
        applied: planned.applied,
        proposed,
        body: planned.body,
    })
}

#[cfg(test)]
mod tests;

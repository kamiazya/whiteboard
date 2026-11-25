//! `wb_thread_edit`: comments on a document through its annotation layer, as
//! server-core's `createThreadEditTool` writes them under one hold of the
//! workspace's write lock.
//!
//! A batch is judged whole before anything is written: every op is applied
//! to what the document held when the batch began, and the first one that
//! cannot be refuses the batch with nothing kept. What a batch writes is
//! written to the document as a copy of its own and stored once, as the
//! content the document's node then holds.
//!
//! What is not answered yet is [`ThreadEditPending`]: a write the content
//! sync declines (one that changes more than one of a document's roots, whose
//! order the TypeScript takes from wasm32's hash map) and a document or a
//! write the engine leaves to its caller.

mod anchor;
mod batch;
mod save;
mod summary;

use whiteboard_api_contracts::Refusal;
use whiteboard_model::Value;
use whiteboard_model::canvas_value::canvas_of;
use whiteboard_model::crdt::QueryName;
use whiteboard_ports::{AgentActivity, ClientNotifier, Clock, Touched, WorkspaceLock};

use crate::content::field;
use crate::document_get::Stop;
use crate::document_get::engine::{Fault, Hosted};
use crate::document_resolve::resolve_in;
use crate::record::load_record;
use crate::{Contract, Operation, Ports, Row};
use anchor::{Board, Content};
pub use anchor::{SpatialAnchor, TextPassage, ThreadAnchor};
use batch::Held;
pub use batch::is_js_space;

/// One op of a batch. There is no remove: a thread is closed, never deleted.
#[derive(Debug, Clone, PartialEq)]
pub enum ThreadOp {
    /// Opens a thread; the id is minted when absent.
    Add { thread_id: Option<String>, anchor: ThreadAnchor, body: String, author: Option<String> },
    /// Replies to a thread the document holds.
    Reply { thread_id: String, body: String, author: Option<String> },
    /// Closes a thread, or reopens it when `resolved` is `false`.
    Resolve { thread_id: String, resolved: Option<bool> },
}

/// The workspace, already resolved to its canonical id, the document, and the
/// ops, in order.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadEditInput {
    pub workspace_id: String,
    pub document_id: String,
    pub ops: Vec<ThreadOp>,
}

/// Every thread the document now holds, each as the annotation reader
/// answers it.
#[derive(Debug, Clone, PartialEq)]
pub struct ThreadEditOutput {
    pub threads: Vec<Value>,
}

/// What this crate does not answer yet, which a binding answers as a pending
/// tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadEditPending {
    /// A write the content sync declines: more than one root changed, or a
    /// document holding a root no writer of the model makes.
    Declined,
    /// A read the record leaves to its caller, or a write the engine's
    /// writer throws on.
    Undecided,
}

/// The call's answer, or the part of it this crate does not answer yet.
#[derive(Debug, Clone, PartialEq)]
pub enum ThreadEditAnswer {
    Edited(ThreadEditOutput),
    Pending(ThreadEditPending),
}

/// `createThreadEditTool`'s execute, which only `wb_thread_edit` calls.
#[derive(Debug, Clone, Copy)]
pub struct ThreadEdit;

/// Why a batch stops before answering.
enum Halt {
    Refused(Refusal),
    Pending(ThreadEditPending),
}

impl From<Refusal> for Halt {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<Fault> for Halt {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Retired(found) => Self::Refused(Refusal::RetiredStoredShape { found }),
            Fault::Stop(Stop::Refused(refusal)) => Self::Refused(refusal),
            Fault::Stop(Stop::Pending(_)) => Self::Pending(ThreadEditPending::Undecided),
        }
    }
}

impl Operation for ThreadEdit {
    type Input = ThreadEditInput;
    type Output = ThreadEditAnswer;

    const ROW: Row = Row {
        name: "threadEdit",
        tool: Some("wb_thread_edit"),
        route: None,
        input: Contract { schema: "threadEditInputSchema" },
        output: Contract { schema: "threadEditOutputSchema" },
    };

    async fn execute<P: Ports>(
        ports: &P,
        input: ThreadEditInput,
    ) -> Result<ThreadEditAnswer, Refusal> {
        let _held = ports.lock().lock(&input.workspace_id).await;
        match edit(ports, &input).await {
            Ok(output) => Ok(ThreadEditAnswer::Edited(output)),
            Err(Halt::Refused(refusal)) => Err(refusal),
            Err(Halt::Pending(pending)) => Ok(ThreadEditAnswer::Pending(pending)),
        }
    }
}

/// The batch applied, stored and announced.
async fn edit<P: Ports>(ports: &P, input: &ThreadEditInput) -> Result<ThreadEditOutput, Halt> {
    let ws = input.workspace_id.as_str();
    let (bytes, record) = load_record(ports.records(), ws).await.map_err(|e| Refusal::from(&e))?;
    let entry = resolve_in(&record, ws, &input.document_id)?;
    let hosted = Hosted { record: &record, document_id: &input.document_id };
    let content = content_of(hosted, entry.kind.as_deref())?;
    let held = Held::read(hosted)?;
    let now = ports.clock().now_iso().map_err(|e| Refusal::from(&e))?;
    let applied = batch::apply(&input.ops, &content, held, &now)?;
    let located = save::Located { workspace_id: ws, id: &input.document_id, path: &entry.path };
    let saved =
        save::store(ports, &bytes, &record, located, entry.kind.as_deref(), &applied.writes)
            .await?;
    // Only a board has a presence surface to show it on; a note has no chip.
    if matches!(content, Content::Board(_)) {
        ports.notifier().agent_activity(&AgentActivity {
            workspace_id: ws.to_owned(),
            document_id: input.document_id.clone(),
            touched: Touched { comments: applied.touched, ..Touched::default() },
            summary: summary::of(&input.ops),
        });
    }
    Ok(ThreadEditOutput { threads: saved })
}

/// What the document holds: a note's body, or a board's ids and node texts.
/// The index row's kind is asked for a document that records none.
fn content_of(hosted: Hosted<'_>, kind: Option<&str>) -> Result<Content, Halt> {
    let asked: Vec<(&str, Value)> =
        kind.iter().map(|kind| ("kind", Value::String((*kind).to_owned()))).collect();
    let read = hosted.read(QueryName::DocumentContent, &asked)?;
    let undecided = || Halt::Pending(ThreadEditPending::Undecided);
    let Some(Value::String(kind)) = field(&read, "kind") else { return Err(undecided()) };
    match kind.as_str() {
        "markdown" => match field(&read, "body") {
            Some(Value::String(body)) => Ok(Content::Note(body.clone())),
            _ => Err(undecided()),
        },
        "spatial" => field(&read, "canvas")
            .and_then(canvas_of)
            .map(|canvas| Content::Board(Board::of(&canvas)))
            .ok_or_else(undecided),
        _ => Err(undecided()),
    }
}

#[cfg(test)]
mod tests;

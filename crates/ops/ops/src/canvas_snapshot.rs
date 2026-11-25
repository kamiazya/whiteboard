//! `wb_canvas_snapshot`: the compact, semantic read of a spatial canvas
//! (server-core's `createCanvasSnapshotTool`), every node with its kind,
//! text, geometry, lock and dressing, every edge and every line, each list
//! and each text cut to a budget with the true totals beside it.
//!
//! The opt-in `layout` field is a full layout pass measured by the daemon's
//! own text measurer, with a fence's tokens asked of the host's tokeniser;
//! no port carries either yet, so a call that reaches it is
//! [`SnapshotPending::Layout`], after every read and refusal before it has
//! answered as the TypeScript's would.

mod project;

use whiteboard_api_contracts::Refusal;
use whiteboard_model::Value;
use whiteboard_model::crdt::QueryName;
use whiteboard_workspace_index::WorkspaceRecord;

use crate::document_get::Stop;
use crate::document_get::engine::{Fault, Hosted, defined};
use crate::document_resolve::resolve_in;
use crate::record::open_record;
use crate::{Contract, Operation, Ports, Row};
pub use project::{
    CanvasSnapshotOutput, SNAPSHOT_MAX_EDGES, SNAPSHOT_MAX_NODES, SNAPSHOT_TEXT_MAX_CHARS, Shown,
    SnapshotEdge, SnapshotLine, SnapshotNode,
};

/// The tool a refusal of a markdown document names.
const TOOL: &str = "wb_canvas_snapshot";

/// The workspace, already resolved to its canonical id, and what to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasSnapshotInput {
    pub workspace_id: String,
    pub document_id: String,
    /// `layout: true`: the laid-out scene's relations beside the board.
    pub layout: bool,
}

/// What this crate does not answer yet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotPending {
    /// The layout pass, which needs a measurement port and a tokeniser.
    Layout,
    /// A read the record leaves to its caller, or an answer this crate's
    /// reading of the engine's contract does not hold.
    UndecidedRead,
    /// Facets the answer would spell in an order only npm loro's hash map
    /// knows (a bucket of several facets, or a payload object of several
    /// keys), which a native build cannot reproduce.
    StoredOrder,
    /// A text whose cut falls between the halves of a surrogate pair, which
    /// the TypeScript answers with a lone surrogate no `String` holds.
    LoneSurrogate,
}

/// The snapshot, or the part of the call this crate does not answer yet.
#[derive(Debug, Clone, PartialEq)]
pub enum CanvasSnapshotAnswer {
    Snapshot(CanvasSnapshotOutput),
    Pending(SnapshotPending),
}

/// `canvasSnapshot`, behind `wb_canvas_snapshot` alone.
#[derive(Debug, Clone, Copy)]
pub struct CanvasSnapshot;

impl Operation for CanvasSnapshot {
    type Input = CanvasSnapshotInput;
    type Output = CanvasSnapshotAnswer;

    const ROW: Row = Row {
        name: "canvasSnapshot",
        tool: Some(TOOL),
        route: None,
        input: Contract { schema: "canvasSnapshotInputSchema" },
        output: Contract { schema: "canvasSnapshotOutputSchema" },
    };

    /// No write lock, as the TypeScript takes none: the snapshot reads the
    /// record as it stands.
    async fn execute<P: Ports>(
        ports: &P,
        input: CanvasSnapshotInput,
    ) -> Result<CanvasSnapshotAnswer, Refusal> {
        let record = open_record(ports.records(), &input.workspace_id)
            .await
            .map_err(|error| Refusal::from(&error))?;
        let snapshot = match read(&record, &input) {
            Ok(snapshot) => snapshot,
            Err(Halt::Refused(refusal)) => return Err(refusal),
            Err(Halt::Pending(pending)) => return Ok(CanvasSnapshotAnswer::Pending(pending)),
        };
        if input.layout {
            return Ok(CanvasSnapshotAnswer::Pending(SnapshotPending::Layout));
        }
        Ok(CanvasSnapshotAnswer::Snapshot(snapshot))
    }
}

/// Why a read stops before a snapshot.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Halt {
    Refused(Refusal),
    Pending(SnapshotPending),
}

impl From<Fault> for Halt {
    fn from(fault: Fault) -> Self {
        match fault {
            Fault::Retired(found) => Self::Refused(Refusal::RetiredStoredShape { found }),
            Fault::Stop(Stop::Refused(refusal)) => Self::Refused(refusal),
            Fault::Stop(Stop::Pending(_)) => Self::Pending(SnapshotPending::UndecidedRead),
        }
    }
}

/// `readOwnedCanvas` and the projection: the document found in the
/// workspace, refused when it is KNOWN to be markdown (its own kind first,
/// its index row's for one that records none), then its canvas and both
/// lock sets read in the TypeScript's order.
fn read(
    record: &WorkspaceRecord,
    input: &CanvasSnapshotInput,
) -> Result<CanvasSnapshotOutput, Halt> {
    let entry =
        resolve_in(record, &input.workspace_id, &input.document_id).map_err(Halt::Refused)?;
    let hosted = Hosted { record, document_id: &input.document_id };
    let stated = match defined(hosted.read(QueryName::DocumentKind, &[])?) {
        Some(Value::String(kind)) => Some(kind),
        _ => None,
    };
    if let Some(kind) = stated.or(entry.kind).filter(|kind| kind == "markdown") {
        return Err(Halt::Refused(Refusal::NotASpatialDocument {
            document_id: input.document_id.clone(),
            kind,
            tool_name: TOOL.to_owned(),
        }));
    }
    let canvas = hosted.read(QueryName::SpatialCanvas, &[])?;
    let node_locks = ids(hosted.read(QueryName::NodeLocks, &[])?)?;
    let edge_locks = ids(hosted.read(QueryName::EdgeLocks, &[])?)?;
    let canvas =
        project::canvas_in(&canvas).ok_or(Halt::Pending(SnapshotPending::UndecidedRead))?;
    project::project(&input.document_id, canvas, &node_locks, &edge_locks)
}

/// A lock set as the engine answers it: a list of ids.
fn ids(answer: Value) -> Result<Vec<String>, Halt> {
    let Value::Seq(items) = answer else {
        return Err(Halt::Pending(SnapshotPending::UndecidedRead));
    };
    items
        .into_iter()
        .map(|item| match item {
            Value::String(id) => Ok(id),
            _ => Err(Halt::Pending(SnapshotPending::UndecidedRead)),
        })
        .collect()
}

#[cfg(test)]
mod tests;

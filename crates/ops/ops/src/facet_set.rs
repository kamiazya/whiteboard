//! `wb_facet_set`: tags and extension facets written to documents, boards,
//! nodes and edges, as server-core's `createFacetSetTool` writes them under
//! one hold of the workspace's write lock.
//!
//! The call refuses in PHASES, and the order is the contract: everything that
//! can refuse the batch runs before the first document is written. Each
//! document is its own copy with its own snapshot and there is no
//! transaction across them, so a refusal discovered while writing leaves a
//! prefix of the batch applied, and a caller reading that error could not
//! learn which documents it got.
//!
//! Answered here: every refusal, and the writes that change one root of a
//! document. What is not answered yet is [`FacetSetPending`].

mod judge;
mod read;
mod refuse;
mod tags;
mod write;

use whiteboard_api_contracts::Refusal;
use whiteboard_facet_engine::plugin_manifest::FacetTarget;
use whiteboard_model::Map;
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_ports::{
    AgentActivity, ClientNotifier, Clock, DocumentWritten, IdMint, WorkspaceLock,
    WorkspaceRecordStore, WriteObserver,
};
use whiteboard_workspace_index::WorkspaceRecord;

use crate::document_resolve::resolve_in;
use crate::record::load_record;
use crate::{Contract, Operation, Ports, Row};
use read::{Doc, Halt, Kind};
use tags::TagEdit;
use write::{Change, Collection, Payload};

pub use tags::TagChange;

/// The documents a call may name: a batch a caller can still read back.
pub const MAX_DOCUMENTS: usize = 50;

/// The workspace, already resolved to its canonical id, and the payload that
/// covers every document named.
#[derive(Debug, Clone, PartialEq)]
pub struct FacetSetInput {
    pub workspace_id: String,
    pub document_ids: Vec<String>,
    pub node_id: Option<String>,
    pub edge_id: Option<String>,
    pub tags: Option<TagChange>,
    /// Where a write naming no node or edge lands; `Canvas` or `Document`.
    pub target: Option<FacetTarget>,
    /// Extension facets by key, a null payload deleting its key.
    pub facets: Option<Map>,
}

/// One document as it stands after the write.
#[derive(Debug, Clone, PartialEq)]
pub struct UpdatedDocument {
    pub document_id: String,
    pub facets: Map,
    /// The tags after the write, when the call carried `tags`.
    pub tags: Option<Vec<String>>,
}

/// One entry per document, in the order asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct FacetSetOutput {
    pub updated: Vec<UpdatedDocument>,
}

/// What this crate does not answer yet, which a binding answers as a pending
/// tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FacetSetPending {
    /// A facet that takes a stencil: the workspace's own stencil library is
    /// composed beside the registry for it, which no operation here reads.
    StencilFacet,
    /// A document whose stored facets the answer would spell in an order only
    /// npm loro's hash map knows (several stored keys, or a payload object of
    /// several keys), which a native build cannot reproduce.
    StoredOrder,
    /// A read the record leaves undecided.
    UndecidedRead,
    /// A write the content sync declines: one that changes more than one of
    /// a document's roots, whose order the TypeScript takes from wasm32's
    /// hash map, or one the engine does not answer.
    Declined,
}

/// The call's answer, or the part of it this crate does not answer yet.
#[derive(Debug, Clone, PartialEq)]
pub enum FacetSetAnswer {
    Updated(FacetSetOutput),
    Pending(FacetSetPending),
}

/// `createFacetSetTool`'s execute, which only `wb_facet_set` calls.
#[derive(Debug, Clone, Copy)]
pub struct FacetSet;

impl Operation for FacetSet {
    type Input = FacetSetInput;
    type Output = FacetSetAnswer;

    const ROW: Row = Row {
        name: "facetSet",
        tool: Some("wb_facet_set"),
        route: None,
        input: Contract { schema: "facetSetInputSchema" },
        output: Contract { schema: "facetSetOutputSchema" },
    };

    async fn execute<P: Ports>(ports: &P, input: FacetSetInput) -> Result<FacetSetAnswer, Refusal> {
        let _held = ports.lock().lock(&input.workspace_id).await;
        match set_facets(ports, &input).await {
            Ok(output) => Ok(FacetSetAnswer::Updated(output)),
            Err(Halt::Refused(refusal)) => Err(refusal),
            Err(Halt::Pending(pending)) => Ok(FacetSetAnswer::Pending(pending)),
        }
    }
}

/// Which SITE a write targets: an element on the board, the board's own
/// envelope, or the document's frontmatter. One answer, read by the write and
/// by its dry run, since the dry run decides what the batch refuses while the
/// write decides what it stores.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Site {
    Node,
    Edge,
    Canvas,
    Document,
}

fn site_of(input: &FacetSetInput, kind: Option<Kind>) -> Site {
    if input.node_id.is_some() {
        Site::Node
    } else if input.edge_id.is_some() {
        Site::Edge
    } else if input.target == Some(FacetTarget::Canvas) || kind == Some(Kind::Spatial) {
        Site::Canvas
    } else {
        Site::Document
    }
}

/// What this write targets, which decides whether a facet may be written.
fn required_target(input: &FacetSetInput) -> FacetTarget {
    if input.node_id.is_some() {
        FacetTarget::Node
    } else if input.edge_id.is_some() {
        FacetTarget::Edge
    } else {
        input.target.unwrap_or(FacetTarget::Document)
    }
}

/// Refuses a request whose own shape is incoherent, before anything is read.
fn refuse_incoherent(input: &FacetSetInput) -> Result<(), Refusal> {
    if input.tags.is_none() && input.facets.is_none() {
        return Err(Refusal::FacetSetNeedsPayload);
    }
    if input.node_id.is_some() && input.edge_id.is_some() {
        return Err(Refusal::NodeAndEdgeTarget);
    }
    if input.node_id.is_none() && input.edge_id.is_none() {
        return Ok(());
    }
    if input.document_ids.len() != 1 {
        return Err(Refusal::NodeTargetNeedsOneDocument {
            count: u64::try_from(input.document_ids.len()).unwrap_or(u64::MAX),
        });
    }
    if input.target == Some(FacetTarget::Canvas) {
        return Err(Refusal::NodeAndCanvasTarget);
    }
    Ok(())
}

/// The call, in phases.
async fn set_facets<P: Ports>(ports: &P, input: &FacetSetInput) -> Result<FacetSetOutput, Halt> {
    refuse_incoherent(input)?;
    let registry = visual_registry().map_err(|_| Refusal::InternalError)?;
    let bucket = input.facets.as_deref().unwrap_or_default();
    if judge::writes_a_stencil(&registry, bucket) {
        return Err(Halt::Pending(FacetSetPending::StencilFacet));
    }
    let writes = judge::judge(&registry, required_target(input), bucket)?;
    let ws = input.workspace_id.as_str();
    let peer = ports.mint().peer_id();
    let (bytes, _) = load_record(ports.records(), ws).await.map_err(|e| Halt::from(&e))?;
    let record = WorkspaceRecord::open_as(&bytes, peer)
        .map_err(|_| Halt::Pending(FacetSetPending::UndecidedRead))?;
    let edit = input.tags.as_ref().map(TagEdit::of);
    refuse::before_any_write(&record, &registry, input, edit.as_ref())?;
    let payload =
        Payload { input, edit: edit.as_ref(), sets: &writes.sets, deletions: &writes.deletions };
    let now_ms = ports.clock().now_ms();
    let mut planned = Vec::with_capacity(input.document_ids.len());
    let mut refused = None;
    for document_id in &input.document_ids {
        match plan_one(&record, &payload, document_id, (peer, now_ms)) {
            Ok(one) => planned.push(one),
            Err(Halt::Refused(refusal)) => {
                refused = Some(refusal);
                break;
            }
            Err(pending @ Halt::Pending(_)) => return Err(pending),
        }
    }
    let output = keep(ports, ws, planned).await?;
    refused.map_or(Ok(output), |refusal| Err(Halt::Refused(refusal)))
}

/// One document's write decided and applied to the call's copy of the record,
/// so the next document of the batch reads what this one left.
struct Planned {
    change: Change,
    document_id: String,
    path: String,
    update: Option<Vec<u8>>,
}

fn plan_one(
    record: &WorkspaceRecord,
    payload: &Payload<'_>,
    document_id: &str,
    (peer, now_ms): (u64, f64),
) -> Result<Planned, Halt> {
    let entry = resolve_in(record, &payload.input.workspace_id, document_id)?;
    let doc = Doc { record, id: document_id };
    let kind = doc.kind()?;
    let input = payload.input;
    let change = match site_of(input, kind) {
        Site::Node => {
            let id = input.node_id.as_deref().unwrap_or_default();
            write::element(payload, doc, kind, Collection::Nodes, id)?
        }
        Site::Edge => {
            let id = input.edge_id.as_deref().unwrap_or_default();
            write::element(payload, doc, kind, Collection::Edges, id)?
        }
        // A kind that cannot hold this write was refused for the whole batch,
        // before the first document was written.
        Site::Canvas => write::canvas(payload, doc, kind)?,
        Site::Document => write::document(payload, doc)?,
    };
    let update =
        write::apply(record, peer, now_ms, document_id, &change.batch).map_err(Halt::Pending)?;
    Ok(Planned { change, document_id: document_id.to_owned(), path: entry.path, update })
}

/// Keeps each planned document in order: its operations stored, the observer
/// told, the pages told. A keeper that cannot store one stops the batch there,
/// the earlier ones kept.
async fn keep<P: Ports>(
    ports: &P,
    workspace_id: &str,
    planned: Vec<Planned>,
) -> Result<FacetSetOutput, Halt> {
    let mut updated = Vec::with_capacity(planned.len());
    for one in planned {
        if let Some(update) = &one.update {
            ports.records().append(workspace_id, update).await.map_err(|e| Halt::from(&e))?;
        }
        announce(ports, workspace_id, &one).await;
        updated.push(one.change.updated);
    }
    Ok(FacetSetOutput { updated })
}

async fn announce<P: Ports>(ports: &P, workspace_id: &str, one: &Planned) {
    ports
        .observer()
        .document_written(&DocumentWritten {
            workspace_id: workspace_id.to_owned(),
            document_id: one.document_id.clone(),
            path: one.path.clone(),
        })
        .await;
    if let Some(activity) = &one.change.activity {
        ports.notifier().agent_activity(&AgentActivity {
            workspace_id: workspace_id.to_owned(),
            document_id: one.document_id.clone(),
            touched: activity.touched.clone(),
            summary: activity.summary.to_owned(),
        });
    }
}

#[cfg(test)]
mod tests;

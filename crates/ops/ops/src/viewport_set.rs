//! `wb_viewport_set`: point the pages a canvas is open in at part of it.

use whiteboard_api_contracts::Refusal;
use whiteboard_model::Value;
use whiteboard_model::crdt::QueryName;
use whiteboard_ports::{ClientNotifier, ViewportRequest};

use crate::content::field;
use crate::document_get::Stop;
use crate::document_get::engine::{Fault, Hosted};
use crate::document_resolve::resolve_in;
use crate::record::open_record;
use crate::{Contract, Operation, Ports, Row};

/// What `DocumentKindMismatch` says the tool does, beside the kind it refused.
const NO_VIEW: &str =
    "wb_viewport_set moves the view of a spatial canvas, and a markdown document has none.";

/// Whether a page was told, or `Pending` for a canvas held in a way this
/// crate does not read yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViewportSetAnswer {
    Told { document_id: String, delivered: bool },
    Pending,
}

/// `createViewportSetTool`'s execute, which only `wb_viewport_set` calls. Its
/// input IS the request the pages are handed, the workspace already resolved
/// to its canonical id: a field added to the request reaches the page with no
/// second list to keep in step.
#[derive(Debug, Clone, Copy)]
pub struct ViewportSet;

impl Operation for ViewportSet {
    type Input = ViewportRequest;
    type Output = ViewportSetAnswer;

    const ROW: Row = Row {
        name: "viewportSet",
        tool: Some("wb_viewport_set"),
        route: None,
        input: Contract { schema: "viewportSetInputSchema" },
        output: Contract { schema: "viewportSetOutputSchema" },
    };

    /// No write lock: nothing stored changes, and asking a page to look
    /// somewhere does not wait on an unrelated edit. Every element named is
    /// checked before a page is told, so a typo'd id is refused whether or
    /// not a page is open, rather than framing nothing and reported told.
    async fn execute<P: Ports>(
        ports: &P,
        request: ViewportRequest,
    ) -> Result<ViewportSetAnswer, Refusal> {
        let record = open_record(ports.records(), &request.workspace_id)
            .await
            .map_err(|error| Refusal::from(&error))?;
        let entry = resolve_in(&record, &request.workspace_id, &request.document_id)?;
        // Only a document KNOWN to be markdown is refused: one that records
        // no kind predates the field and may be a canvas.
        if entry.kind.as_deref() == Some("markdown") {
            return Err(Refusal::DocumentKindMismatch {
                document_id: request.document_id,
                kind: "markdown".to_owned(),
                detail: NO_VIEW.to_owned(),
            });
        }
        if let Some(wanted) = request.element_ids.as_ref().filter(|ids| !ids.is_empty()) {
            let hosted = Hosted { record: &record, document_id: &request.document_id };
            let held = match node_ids(hosted) {
                Ok(held) => held,
                Err(Unread::Refused(refusal)) => return Err(refusal),
                Err(Unread::Pending) => return Ok(ViewportSetAnswer::Pending),
            };
            if let Some(missing) = wanted.iter().find(|id| !held.contains(id)) {
                return Err(Refusal::NodeNotFound {
                    document_id: request.document_id.clone(),
                    node_id: missing.clone(),
                });
            }
        }
        let delivered = ports.notifier().request_viewport(&request).await;
        Ok(ViewportSetAnswer::Told { document_id: request.document_id, delivered })
    }
}

/// Why a canvas's node ids are not answered.
enum Unread {
    Refused(Refusal),
    Pending,
}

/// The ids of the nodes the canvas holds, as the engine's `spatialCanvas`
/// answers it: a record its schema skipped is not there to frame.
fn node_ids(hosted: Hosted<'_>) -> Result<Vec<String>, Unread> {
    let read = hosted.read(QueryName::SpatialCanvas, &[]).map_err(|fault| match fault {
        Fault::Retired(found) => Unread::Refused(Refusal::RetiredStoredShape { found }),
        Fault::Stop(Stop::Refused(refusal)) => Unread::Refused(refusal),
        Fault::Stop(Stop::Pending(_)) => Unread::Pending,
    })?;
    let nodes = field(&read, "canvas").and_then(|canvas| field(canvas, "nodes"));
    let Some(Value::Seq(nodes)) = nodes else { return Err(Unread::Pending) };
    nodes
        .iter()
        .map(|node| match field(node, "id") {
            Some(Value::String(id)) => Ok(id.clone()),
            _ => Err(Unread::Pending),
        })
        .collect()
}

#[cfg(test)]
mod tests;

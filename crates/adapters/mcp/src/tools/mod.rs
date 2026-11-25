//! The tool catalogue over the ops table: each tool whose operation
//! `whiteboard-ops` implements, listed as its contract publishes it and
//! called as the TypeScript's tool wrapper calls it.
//!
//! A tool's published surface is `contracts/tools/<name>.json`, written from
//! the TypeScript server's own `tools/list` and held equal to it there
//! (`packages/mcp-server/src/server/mcp/tool-contracts.oracle.test.ts`). A
//! call is judged against the input the binding declares, in the SDK's words,
//! run through the operation, and answered with the output as
//! `structuredContent` and as its `JSON.stringify` text, or with the
//! operation's refusal.

mod body_edit;
mod canvas_snapshot;
mod document_get;
mod document_list;
mod document_search;
mod facet_list;
mod facet_set;
mod input;
mod json;
mod thread_edit;
mod version_list;
mod version_restore;
mod version_save;
mod viewport_set;
mod workspace_edit;

use serde_json::{Map, Value, json};
use whiteboard_ops::{
    BodyEdit, CanvasSnapshot, DocumentGet, DocumentList, DocumentSearch, FacetList, FacetSet,
    Operation, Ports, ThreadEdit, VersionList, VersionRestore, VersionSave, ViewportSet,
    WorkspaceEdit, with_resolved_workspace,
};

use crate::{ToolCatalogue, ToolError};
use input::Input;
use json::Json;

/// The tools the TypeScript registers whose operation is not ported yet:
/// not listed, and `Tool <name> not found` when called. A tool leaves this
/// list in the slice that binds its operation.
pub const PENDING_TOOLS: &[&str] = &[
    "canvas_view",
    "wb_canvas_edit",
    "wb_canvas_snapshot",
    "wb_facet_set",
    "wb_scene_render",
    "wb_thread_edit",
    "wb_version_restore",
    "wb_workspace_edit",
];

/// The pending tools a call already reaches: not listed, since most of what
/// they do is not ported, but a call is judged and answered as far as the
/// operation answers it, and the rest is `Tool <name> not found`.
pub const PARTLY_BOUND_TOOLS: &[&str] = &[
    "wb_canvas_snapshot",
    "wb_facet_set",
    "wb_thread_edit",
    "wb_version_restore",
    "wb_workspace_edit",
];

/// An operation as a tool: its name and contract, its input as the SDK
/// judges it, and its output as the tool answers it.
trait Binding: Operation {
    const NAME: &str;
    /// The contract file's text: the tool as `tools/list` publishes it.
    const CONTRACT: &str;
    const INPUT: Input;
    /// Whether the operation resolves the `workspaceId` address itself, as a
    /// tool whose refusal of an unknown workspace depends on the call does:
    /// the address then reaches it as the caller typed it.
    const RESOLVES_ITS_WORKSPACE: bool = false;

    /// The operation's input from arguments `INPUT` has passed, its workspace
    /// the canonical id the `workspaceId` address resolved to, or `None`
    /// when the arguments name none (which only a tool whose `INPUT` leaves
    /// the address optional admits).
    fn input(arguments: &Map<String, Value>, workspace_id: Option<String>) -> Self::Input;

    /// The tool's answer, or `None` where the operation met what it does not
    /// answer yet, which the call answers as a pending tool is.
    fn output(output: &Self::Output) -> Option<Json>;

    /// Whether the SDK's refusal of the arguments, as `INPUT` worded it,
    /// holds a fault whose words this binding has no recording of: the call
    /// is then answered as a pending tool, not refused in words guessed.
    fn unjudged(_refusal: &str) -> bool {
        false
    }
}

/// The tools of the ops table, over one ports bundle.
pub struct OpsCatalogue<P> {
    ports: P,
}

impl<P: Ports> OpsCatalogue<P> {
    pub fn new(ports: P) -> Self {
        Self { ports }
    }
}

impl<P: Ports> ToolCatalogue for OpsCatalogue<P> {
    fn tools(&self) -> Vec<Value> {
        vec![
            contract::<DocumentList>(),
            contract::<DocumentGet>(),
            contract::<VersionList>(),
            contract::<VersionSave>(),
            contract::<FacetList>(),
            contract::<DocumentSearch>(),
            contract::<ViewportSet>(),
            contract::<BodyEdit>(),
        ]
    }

    async fn call(
        &self,
        name: &str,
        arguments: Option<&Map<String, Value>>,
    ) -> Result<Value, ToolError> {
        match name {
            DocumentList::NAME => run::<DocumentList, P>(&self.ports, arguments).await,
            DocumentGet::NAME => run::<DocumentGet, P>(&self.ports, arguments).await,
            VersionList::NAME => run::<VersionList, P>(&self.ports, arguments).await,
            VersionSave::NAME => run::<VersionSave, P>(&self.ports, arguments).await,
            FacetSet::NAME => run::<FacetSet, P>(&self.ports, arguments).await,
            VersionRestore::NAME => run::<VersionRestore, P>(&self.ports, arguments).await,
            FacetList::NAME => run::<FacetList, P>(&self.ports, arguments).await,
            DocumentSearch::NAME => run::<DocumentSearch, P>(&self.ports, arguments).await,
            ViewportSet::NAME => run::<ViewportSet, P>(&self.ports, arguments).await,
            BodyEdit::NAME => run::<BodyEdit, P>(&self.ports, arguments).await,
            ThreadEdit::NAME => run::<ThreadEdit, P>(&self.ports, arguments).await,
            WorkspaceEdit::NAME => run::<WorkspaceEdit, P>(&self.ports, arguments).await,
            CanvasSnapshot::NAME => run::<CanvasSnapshot, P>(&self.ports, arguments).await,
            _ => Err(ToolError::NotFound),
        }
    }
}

/// The tool as its contract publishes it; the contract is held to parse by
/// the catalogue's tests.
fn contract<B: Binding>() -> Value {
    serde_json::from_str(B::CONTRACT).unwrap_or_default()
}

/// One call: the SDK's judgement of the arguments (absent: an empty object),
/// the `workspaceId` address resolved as server-core's tool record resolves
/// it when the arguments name one (`INPUT` has held it to be a string) and
/// the operation does not resolve it itself, the operation, and the result
/// the tool wrapper answers.
async fn run<B: Binding, P: Ports>(
    ports: &P,
    arguments: Option<&Map<String, Value>>,
) -> Result<Value, ToolError> {
    let empty = Map::new();
    let arguments = arguments.unwrap_or(&empty);
    if let Some(text) = input::refusal(B::NAME, &B::INPUT, arguments) {
        return Err(if B::unjudged(&text) { ToolError::NotFound } else { ToolError::Failed(text) });
    }
    let address = arguments.get("workspaceId").and_then(Value::as_str);
    let output = match address.filter(|_| !B::RESOLVES_ITS_WORKSPACE) {
        Some(handle) => {
            with_resolved_workspace(ports, handle, |workspace_id| {
                B::execute(ports, B::input(arguments, Some(workspace_id)))
            })
            .await
        }
        None => B::execute(ports, B::input(arguments, None)).await,
    }
    .map_err(ToolError::Refused)?;
    let output = B::output(&output).ok_or(ToolError::NotFound)?;
    Ok(json!({
        "content": [{ "type": "text", "text": output.text() }],
        "structuredContent": output.value(),
    }))
}

//! Every `/api/v1` operation and MCP tool as a transport-neutral function
//! (ADR-0054, the `ops` layer). `packages/server-core`'s operations are the
//! oracle until they are deleted.
//!
//! The shape every operation follows:
//!
//! - An [`Operation`] is a unit type with an `Input`, an `Output` and an async
//!   `execute` over a [`Ports`] bundle, answering `Result<Output, Refusal>`.
//!   A refusal is a value from `whiteboard-api-contracts`, in the TypeScript's
//!   own words; a port's failure becomes one through `From<&PortError>`, and
//!   an operation re-words it only where the TypeScript does (a listing
//!   refuses an unknown workspace with the advice for a read).
//! - `execute` returns `impl Future + MaybeSend` (RPITIT): `Send` natively, so
//!   a daemon may move it between threads, and nothing on wasm32, where the
//!   ports are the host's promises. No executor is named here; the binding
//!   that drives the future owns one. Because the future borrows the bundle
//!   across an await, the bundle is `MaybeSync`.
//! - The bundle grows one associated type per port, so an operation reaches
//!   exactly the ports it names and a fake bundle is a struct of fakes.
//! - The table ([`OPERATIONS`], [`each_operation`]) is data: one [`Row`] per
//!   operation naming its tool, its route and its input and output contracts,
//!   with `execute` reached through the type. An adapter builds its dispatch
//!   from it rather than from a list of its own, and `whiteboard-mcp` holds
//!   every tool a row names to be listed. The contracts are named by the
//!   server-core schema they mirror; a tool's published surface is
//!   `contracts/tools/<name>.json`, and input validation is the adapter's.
//! - A workspace arrives as the caller's ADDRESS (an id, `<handle>/<segment>`
//!   or a segment of the caller's own) and is resolved once, before the
//!   operation runs, by [`with_resolved_workspace`]: the registry and the
//!   caller are ports, an address nothing answers to is refused with a read's
//!   advice (naming the workspaces here when the caller may see them), and
//!   the operation's refusal is re-said with the handle the caller typed. An
//!   operation itself sees only the canonical id.
//! - A read opens the workspace record from the bytes the store answers and
//!   answers from `whiteboard-workspace-index`'s reads. A write goes through
//!   one bracket — lock, load, engine write, persist, release — which lands
//!   with the first operation that writes.

mod address;
mod document_get;
mod document_list;
mod document_resolve;
mod facet_list;
mod operation;
mod ports;
mod record;
mod table;
mod version_list;

pub use address::{
    WorkspaceAddress, parse_workspace_address, resolve_workspace, with_resolved_workspace,
};
pub use document_get::{
    DocumentGet, DocumentGetAnswer, DocumentGetInput, DocumentGetOutput, FailedRead, Pending,
    ReadDocument,
};
pub use document_list::{
    DocumentList, DocumentListInput, DocumentListOutput, FolderName, ListedDocument,
};
pub use document_resolve::{DocumentDetail, DocumentResolve, DocumentResolveInput};
pub use facet_list::{
    AssetEntry, FacetEntry, FacetList, FacetListAnswer, FacetListInput, FacetListOutput,
};
pub use operation::{Contract, Method, Operation, Route, Row};
pub use ports::Ports;
pub use table::{OPERATIONS, Visit, each_operation};
pub use version_list::{VersionList, VersionListInput, VersionListOutput};
/// The facet vocabulary a listing is filtered by, as the engine names it.
pub use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetTarget};

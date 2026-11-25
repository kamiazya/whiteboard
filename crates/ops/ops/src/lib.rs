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
//!   answers from `whiteboard-workspace-index`'s reads. A write holds the
//!   workspace's write lock ([`Ports::lock`]) for the whole of it; a write to
//!   the record goes through one bracket — lock, load, engine write, persist,
//!   release — which lands with the first operation that writes the record.

mod address;
mod body_edit;
mod content;
mod document_get;
mod document_list;
mod document_resolve;
mod document_save;
mod document_search;
mod facet_list;
mod facet_set;
mod operation;
mod ports;
mod record;
mod table;
mod text_refusal;
mod thread_edit;
mod version_list;
mod version_restore;
mod version_save;
mod viewport_set;

pub use address::{
    WorkspaceAddress, parse_workspace_address, resolve_workspace, with_resolved_workspace,
};
pub use body_edit::{
    BodyEdit, BodyEditAnswer, BodyEditInput, BodyEditMode, BodyEditOutput, BodyEditPending,
    BodyReplace, MAX_PASSAGES,
};
pub use document_get::{
    DocumentGet, DocumentGetAnswer, DocumentGetInput, DocumentGetOutput, FailedRead, Pending,
    ReadDocument,
};
pub use document_list::{
    DocumentList, DocumentListInput, DocumentListOutput, FolderName, ListedDocument,
};
pub use document_resolve::{DocumentDetail, DocumentResolve, DocumentResolveInput};
pub use document_search::{
    DocumentSearch, DocumentSearchAnswer, DocumentSearchInput, SearchResult,
};
pub use facet_list::{
    AssetEntry, DeclaredKey, DeclaredValue, FacetEntry, FacetList, FacetListAnswer, FacetListInput,
    FacetListOutput, TagInUse, WorkspaceTags,
};
pub use facet_set::{
    FacetSet, FacetSetAnswer, FacetSetInput, FacetSetOutput, FacetSetPending, MAX_DOCUMENTS,
    TagChange, UpdatedDocument,
};
pub use operation::{Contract, Method, Operation, Route, Row};
pub use ports::Ports;
pub use table::{OPERATIONS, Visit, each_operation};
pub use thread_edit::{
    SpatialAnchor, TextPassage, ThreadAnchor, ThreadEdit, ThreadEditAnswer, ThreadEditInput,
    ThreadEditOutput, ThreadEditPending, ThreadOp, is_js_space,
};
pub use version_list::{VersionList, VersionListInput, VersionListOutput};
pub use version_restore::{
    RestorePending, VersionRestore, VersionRestoreAnswer, VersionRestoreInput, VersionRestored,
};
pub use version_save::{SavedDocumentVersion, VersionSave, VersionSaveInput, VersionSaveOutput};
pub use viewport_set::{ViewportSet, ViewportSetAnswer};
/// The facet vocabulary a listing is filtered by, as the engine names it.
pub use whiteboard_facet_engine::plugin_manifest::{AssetKind, FacetTarget};

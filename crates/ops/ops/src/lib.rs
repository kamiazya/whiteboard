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
//!   from it rather than from a list of its own. The contracts are named by
//!   the server-core schema they mirror until the tool contracts are generated
//!   from `contracts/`; input validation is the adapter's, against them.
//! - A read opens the workspace record from the bytes the store answers and
//!   answers from `whiteboard-workspace-index`'s reads. A write goes through
//!   one bracket — lock, load, engine write, persist, release — which lands
//!   with the first operation that writes.

mod document_list;
mod document_resolve;
mod operation;
mod ports;
mod record;
mod table;

pub use document_list::{
    DocumentList, DocumentListInput, DocumentListOutput, FolderName, ListedDocument,
};
pub use document_resolve::{DocumentDetail, DocumentResolve, DocumentResolveInput};
pub use operation::{Contract, Method, Operation, Route, Row};
pub use ports::Ports;
pub use table::{OPERATIONS, Visit, each_operation};

//! The only route to I/O (ADR-0054 decision 7): the traits an operation reaches
//! the outside through, and the error taxonomy every one of them answers with.
//!
//! This crate holds contracts, never behaviour: no runtime, no executor, no
//! clock read. Each port is implemented by a mechanic over a concrete store, or
//! by a fake from `whiteboard-port-fakes`, and the same operation runs over
//! either. It builds unchanged for wasm32 and native, which `cargo xtask
//! cross-target` and `cargo xtask wasm-imports` hold.

pub mod caller;
pub mod clock;
pub mod error;
pub mod id_mint;
pub mod lock;
pub mod maybe_send;
pub mod record_store;
pub mod version_store;
pub mod workspace_registry;

pub use caller::{Caller, SINGLE_PERSON_NAMESPACE};
pub use clock::Clock;
pub use error::{PortError, PortErrorKind, SnapshotReassemblyCode, StoredUnreadableCode};
pub use id_mint::IdMint;
pub use lock::WorkspaceLock;
pub use maybe_send::{MaybeSend, MaybeSync};
pub use record_store::WorkspaceRecordStore;
pub use version_store::{NewVersion, OperatorKind, SavedVersion, VersionOperator, VersionStore};
pub use workspace_registry::{WorkspaceEntry, WorkspaceLookup, WorkspaceRegistry};

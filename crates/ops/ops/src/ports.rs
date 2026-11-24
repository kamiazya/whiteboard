//! The ports an operation runs over, as one bundle.

use whiteboard_ports::{Caller, MaybeSync, VersionStore, WorkspaceRecordStore, WorkspaceRegistry};

/// Everything an operation may reach the outside through. A composition root
/// implements it once over its mechanics, and a test over fakes.
///
/// One associated type per port, joined as the first operation needs each,
/// so an implementation is never asked for a port no operation calls.
pub trait Ports: MaybeSync {
    /// Where workspace records are kept.
    type Records: WorkspaceRecordStore + MaybeSync;
    /// Which workspace an address names.
    type Registry: WorkspaceRegistry + MaybeSync;
    /// Who the call is served for.
    type Caller: Caller + MaybeSync;
    /// Where documents' saved versions are kept.
    type Versions: VersionStore + MaybeSync;

    fn records(&self) -> &Self::Records;

    fn registry(&self) -> &Self::Registry;

    fn caller(&self) -> &Self::Caller;

    fn versions(&self) -> &Self::Versions;
}

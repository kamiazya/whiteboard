//! The ports an operation runs over, as one bundle.

use whiteboard_ports::{MaybeSync, WorkspaceRecordStore};

/// Everything an operation may reach the outside through. A composition root
/// implements it once over its mechanics, and a test over fakes.
///
/// One associated type per port, joined as the first operation needs each,
/// so an implementation is never asked for a port no operation calls.
pub trait Ports: MaybeSync {
    /// Where workspace records are kept.
    type Records: WorkspaceRecordStore + MaybeSync;

    fn records(&self) -> &Self::Records;
}

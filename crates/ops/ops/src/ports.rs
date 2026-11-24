//! The ports an operation runs over, as one bundle.

use whiteboard_ports::{
    Caller, ClientNotifier, Clock, IdMint, MaybeSync, VersionStore, WorkspaceLock,
    WorkspaceRecordStore, WorkspaceRegistry, WriteObserver,
};

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
    /// The workspace write lock every writer holds for its whole write, so a
    /// write of several documents is one point in time.
    type Lock: WorkspaceLock + MaybeSync;
    /// The time a write stamps.
    type Clock: Clock + MaybeSync;
    /// The replica a write to a record writes as.
    type Mint: IdMint + MaybeSync;
    /// The pages a document is open in, as a tool reaches them.
    type Notifier: ClientNotifier + MaybeSync;
    /// What a keeper does once a document's content was written.
    type Observer: WriteObserver + MaybeSync;

    fn records(&self) -> &Self::Records;

    fn registry(&self) -> &Self::Registry;

    fn caller(&self) -> &Self::Caller;

    fn versions(&self) -> &Self::Versions;

    fn lock(&self) -> &Self::Lock;

    fn clock(&self) -> &Self::Clock;

    fn mint(&self) -> &Self::Mint;

    fn notifier(&self) -> &Self::Notifier;

    fn observer(&self) -> &Self::Observer;
}

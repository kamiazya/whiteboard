//! Where a workspace record's bytes are kept.

use std::future::Future;

use crate::{MaybeSend, PortError};

/// The workspace records a keeper holds, read whole: the bytes a loro
/// snapshot (and any updates after it) import from. Natively a database row
/// and its log; on Workers a Durable Object's storage.
///
/// Coarse on purpose: the record is a CRDT document, so what a reader needs is
/// the bytes, and how a keeper splits them into chunks and a log is its own. A
/// writer appends what it wrote as one update; compacting is the keeper's.
pub trait WorkspaceRecordStore {
    /// The record of `workspace_id`, or `None` when no workspace has that id:
    /// "no such workspace" is the caller's to refuse, in the words of the call
    /// it was serving, and an empty workspace is not it.
    fn load(
        &self,
        workspace_id: &str,
    ) -> impl Future<Output = Result<Option<Vec<u8>>, PortError>> + MaybeSend;

    /// Keeps `update`, the operations a writer made on the record `load`
    /// answered, so the next `load` answers the record with them. The writer
    /// holds the workspace's write lock across its load and this append, so
    /// nothing lands between them. A keeper that cannot keep it answers the
    /// failure and keeps nothing of it.
    fn append(
        &self,
        workspace_id: &str,
        update: &[u8],
    ) -> impl Future<Output = Result<(), PortError>> + MaybeSend;
}

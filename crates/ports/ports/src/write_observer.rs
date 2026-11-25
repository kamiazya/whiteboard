//! What a keeper does after a document's content was written: schedule its
//! checkpoint and its compaction, as it does after any save.

use std::future::Future;

use crate::MaybeSend;

/// A document whose content a write just changed and stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentWritten {
    pub workspace_id: String,
    pub document_id: String,
    pub path: String,
}

/// A document a move carried from one path to another; whatever sat below
/// `from` now sits below `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentMoved {
    pub workspace_id: String,
    pub from: String,
    pub to: String,
}

/// The seam a write announces itself through (server-core's
/// `documentWritten`). Told after the bytes are stored, and never able to
/// undo them: a keeper whose scheduling fails keeps the write, so nothing
/// here fails.
pub trait WriteObserver {
    fn document_written(&self, written: &DocumentWritten) -> impl Future<Output = ()> + MaybeSend;

    /// A pending checkpoint is keyed by path, so a move hands it on: left
    /// under the old path the keeper would save a document no longer there
    /// (the TypeScript index's `checkpointAfterMove`). Told after the write
    /// that preceded the move, never before it.
    fn document_moved(&self, moved: &DocumentMoved) -> impl Future<Output = ()> + MaybeSend;
}

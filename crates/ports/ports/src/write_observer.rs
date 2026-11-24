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

/// The seam a write announces itself through (server-core's
/// `documentWritten`). Told after the bytes are stored, and never able to
/// undo them: a keeper whose scheduling fails keeps the write, so nothing
/// here fails.
pub trait WriteObserver {
    fn document_written(&self, written: &DocumentWritten) -> impl Future<Output = ()> + MaybeSend;
}

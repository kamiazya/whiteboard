//! Why an index write answered nothing: the refusals the port names, each
//! carrying what a keeper words its message from.

use crate::entry::EntryError;
use crate::index_rules::DisplayNameTaken;
use whiteboard_crdt::WriteError;

/// A refused write. Nothing of it was kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexError {
    /// An input the port's schema refuses.
    InvalidInput,
    DocumentNotFound {
        workspace_id: String,
        /// The path or the id the caller named, whichever the operation takes.
        target: String,
    },
    /// A document already owns the path.
    PathTaken {
        workspace_id: String,
        path: String,
    },
    /// More than one document carries the path.
    PathContested {
        workspace_id: String,
        path: String,
    },
    MoveIntoSelf {
        from: String,
        to: String,
    },
    HasDescendants {
        path: String,
        /// Names a descendant the caller would be destroying.
        detail: String,
    },
    DisplayNameTaken(DisplayNameTaken),
    /// The write would leave the workspace holding more documents than it may.
    TooManyDocuments {
        documents: usize,
    },
    /// The write would leave the workspace holding more folders than it may.
    TooManyFolders {
        folders: usize,
    },
    /// The source's folder leaves no room beside it for a copy segment.
    NoRoomForCopy {
        path: String,
    },
    /// A stored timestamp no JavaScript `Date` holds.
    InvalidTime(EntryError),
    /// Loro refused an operation the write needed.
    Record(WriteError),
}

impl From<WriteError> for IndexError {
    fn from(error: WriteError) -> Self {
        Self::Record(error)
    }
}

impl From<DisplayNameTaken> for IndexError {
    fn from(taken: DisplayNameTaken) -> Self {
        Self::DisplayNameTaken(taken)
    }
}

impl From<EntryError> for IndexError {
    fn from(error: EntryError) -> Self {
        Self::InvalidTime(error)
    }
}

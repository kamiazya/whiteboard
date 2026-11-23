//! What a port's failure is answered as: the one place a `PortError` becomes a
//! refusal, so an adapter maps a status from the refusal and never from the
//! port's own kind.

use whiteboard_ports::{PortError, StoredUnreadableCode};

use crate::Refusal;

/// A count a refusal prints; a `usize` past `u64` cannot occur on a target
/// this builds for, and saturating keeps the conversion total.
fn count(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(u64::MAX)
}

impl From<&PortError> for Refusal {
    fn from(error: &PortError) -> Self {
        match error {
            PortError::WorkspaceNotFound { workspace_id } => {
                Self::WorkspaceNotFoundInIndex { workspace_id: workspace_id.clone() }
            }
            PortError::DocumentNotFound { workspace_id, target } => Self::DocumentNotFoundInIndex {
                target: target.clone(),
                workspace_id: workspace_id.clone(),
            },
            PortError::DatabaseBusy => Self::DatabaseBusy,
            PortError::StoredDocumentUnreadable {
                code: StoredUnreadableCode::UnsupportedVersion,
                message,
            } => Self::StoredDocumentUnsupportedVersion { message: message.clone() },
            PortError::StoredDocumentUnreadable { message, .. }
            | PortError::SnapshotReassembly { message, .. } => {
                Self::CorruptStoredData { message: message.clone() }
            }
            PortError::TooManyWorkspaces { namespace, limit } => {
                Self::TooManyWorkspaces { namespace: namespace.clone(), limit: count(*limit) }
            }
            PortError::TooManyDocuments { documents, limit } => {
                Self::TooManyDocuments { documents: count(*documents), limit: count(*limit) }
            }
            PortError::TooManyFolders { folders, limit } => {
                Self::TooManyFolders { folders: count(*folders), limit: count(*limit) }
            }
            // The TypeScript answers a clock no `Date` holds as any other
            // uncaught throw.
            PortError::InvalidTime => Self::InternalError,
        }
    }
}

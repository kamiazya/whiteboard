//! A workspace record opened from the bytes its store holds.

use whiteboard_ports::{PortError, StoredUnreadableCode, WorkspaceRecordStore};
use whiteboard_workspace_index::WorkspaceRecord;

/// The record of `workspace_id`, refused as not found when the store holds
/// none, and as unreadable when its bytes do not import: the record is there
/// and damaged, which is never folded into not-found.
pub(crate) async fn open_record(
    store: &impl WorkspaceRecordStore,
    workspace_id: &str,
) -> Result<WorkspaceRecord, PortError> {
    let Some(bytes) = store.load(workspace_id).await? else {
        return Err(PortError::WorkspaceNotFound { workspace_id: workspace_id.to_owned() });
    };
    WorkspaceRecord::open(&bytes).map_err(|cause| PortError::StoredDocumentUnreadable {
        code: StoredUnreadableCode::Malformed,
        message: format!("stored workspace document {workspace_id} could not be imported: {cause}"),
    })
}

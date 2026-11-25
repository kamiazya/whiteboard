//! One op applied to the batch's copy of the record, as the tool's handler
//! for it applies it: a folder named through the index, a document moved and
//! renamed (`wbDocumentMove`, then the index's name), a spatial document
//! created, and what is not answered yet left pending.

use whiteboard_api_contracts::Refusal;
use whiteboard_workspace_index::display_name::js_trim;
use whiteboard_workspace_index::{
    MoveDocument, SetDocumentName, SetFolderName, list_documents, move_document,
    resolve_document_by_id, set_document_name_of, set_folder_name_of,
};

use super::{AppliedOp, Batch, Halt, WorkspaceOp, create, follow, refused};
use crate::Ports;

/// The op applied, or why the batch stops at it.
pub(super) fn apply<P: Ports>(
    ports: &P,
    batch: &mut Batch<'_>,
    op: &WorkspaceOp,
) -> Result<AppliedOp, Halt> {
    let name = op.name();
    match op {
        WorkspaceOp::CreateSpatial { path, name: given } => {
            let (document_id, path) = create::spatial(ports, batch, path, given.as_deref())?;
            Ok(AppliedOp { op: name, document_id: Some(document_id), path: Some(path) })
        }
        WorkspaceOp::Move { document_id, path, name: given } => {
            let path = moved(batch, document_id, path.as_deref(), given.as_deref())?;
            Ok(AppliedOp { op: name, document_id: Some(document_id.clone()), path: Some(path) })
        }
        WorkspaceOp::FolderRename { path, name: given } => {
            let input =
                SetFolderName { workspace_id: batch.workspace_id, path, name: given.as_deref() };
            set_folder_name_of(&batch.record, &input).map_err(refused::of)?;
            Ok(AppliedOp { op: name, document_id: None, path: Some(path.clone()) })
        }
        // A delete evacuates the document into a blob before it removes it,
        // and no port here holds blobs; an unknown document is refused first.
        WorkspaceOp::Delete { document_id } => {
            located(batch, document_id)?;
            Err(Halt::Pending)
        }
        WorkspaceOp::CreateMarkdown | WorkspaceOp::Set => Err(Halt::Pending),
    }
}

/// The path of the document `document_id` names, refused as the tool refuses
/// a document the workspace does not hold.
fn located(batch: &Batch<'_>, document_id: &str) -> Result<String, Halt> {
    match resolve_document_by_id(&batch.record, document_id) {
        Ok(Some(entry)) => Ok(entry.path),
        Ok(None) => Err(not_found(batch, document_id)),
        Err(_) => Err(Halt::Pending),
    }
}

fn not_found(batch: &Batch<'_>, document_id: &str) -> Halt {
    Halt::Refused(Refusal::DocumentNotFound {
        document_id: document_id.to_owned(),
        workspace_id: batch.workspace_id.to_owned(),
    })
}

/// `document.move`: the move first, when the op names a path, then the
/// rename, when it names a name; a name refused after the move leaves the
/// move standing, as the TypeScript's does. The path the document holds after.
fn moved(
    batch: &Batch<'_>,
    document_id: &str,
    to: Option<&str>,
    name: Option<&str>,
) -> Result<String, Halt> {
    let path = match (to, name) {
        (None, None) => return Err(Halt::Refused(Refusal::DocumentMoveNeedsTarget)),
        (Some(to), _) => moved_to(batch, document_id, to)?,
        (None, Some(_)) => located(batch, document_id)?,
    };
    if let Some(name) = name {
        // Blank means no name, the normalisation a create applies.
        let name = js_trim(name);
        let input = SetDocumentName {
            workspace_id: batch.workspace_id,
            document_id,
            name: (!name.is_empty()).then_some(name),
        };
        set_document_name_of(&batch.record, &input).map_err(refused::of)?;
    }
    Ok(path)
}

/// `wbDocumentMove`: the listing before the move, the move, and the follow
/// pass, which this crate answers only when no document names what moved.
fn moved_to(batch: &Batch<'_>, document_id: &str, to: &str) -> Result<String, Halt> {
    let before = list_documents(&batch.record).map_err(|_| Halt::Pending)?;
    let Some(entry) = before.iter().find(|entry| entry.document_id == document_id) else {
        return Err(not_found(batch, document_id));
    };
    if entry.path == to {
        return Ok(to.to_owned());
    }
    let input = MoveDocument { workspace_id: batch.workspace_id, from: &entry.path, to };
    move_document(&batch.record, &input).map_err(refused::of)?;
    if follow::rewrites_any(&batch.record, &before, &entry.path)? {
        return Err(Halt::Pending);
    }
    Ok(to.to_owned())
}

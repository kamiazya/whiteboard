//! An index's refusal as the tool quotes it: the sentence the TypeScript
//! index throws for each, and what this crate does not word yet left pending.

use whiteboard_api_contracts::Refusal;
use whiteboard_workspace_index::IndexError;
use whiteboard_workspace_index::display_name::NamedKind;

use super::Halt;

/// The refusal the index's error is quoted as.
pub(super) fn of(error: IndexError) -> Halt {
    Halt::Refused(match error {
        IndexError::DocumentNotFound { workspace_id, target } => {
            Refusal::DocumentNotFoundInIndex { target, workspace_id }
        }
        IndexError::PathTaken { workspace_id, path } => {
            Refusal::DocumentPathTaken { path, workspace_id }
        }
        IndexError::MoveIntoSelf { from, to } => Refusal::DocumentMoveIntoSelf { from, to },
        IndexError::DisplayNameTaken(taken) => Refusal::DisplayNameTaken {
            display_name: taken.display_name,
            kind: match taken.kind {
                NamedKind::Document => "document",
                NamedKind::Folder => "folder",
            }
            .to_owned(),
        },
        // A delete, a copy and a restore raise the rest; the ceilings, a
        // refused input and a record the writers cannot write are worded by
        // no recording yet.
        _ => return Halt::Pending,
    })
}

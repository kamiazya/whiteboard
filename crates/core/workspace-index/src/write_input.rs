//! The port's input schemas for the index's writes, as the refusals they make.
//! Only the fields a rule reads are checked; a typed caller cannot misspell a key.

use crate::display_name::js_trim;
use crate::document_path::is_document_path;
use crate::index_error::IndexError;
use whiteboard_det::utf16;
use whiteboard_model::checks::canonical_ulid;

/// `DOCUMENT_NAME_MAX_LENGTH`, in UTF-16 units.
pub const DOCUMENT_NAME_MAX_LENGTH: usize = 200;

fn require(valid: bool) -> Result<(), IndexError> {
    if valid { Ok(()) } else { Err(IndexError::InvalidInput) }
}

/// `workspaceCanonicalIdSchema` and `documentIdSchema`: a canonical ULID.
pub fn require_id(id: &str) -> Result<(), IndexError> {
    require(canonical_ulid(id))
}

/// `documentPathSchema`.
pub fn require_path(path: &str) -> Result<(), IndexError> {
    require(is_document_path(path))
}

/// `documentNameSchema`: bounded in UTF-16 units; blank is allowed.
pub fn require_name(name: &str) -> Result<(), IndexError> {
    require(utf16::len(name) <= DOCUMENT_NAME_MAX_LENGTH)
}

/// Why `name` cannot be a folder's display name (`folderNameRefusal`, as a yes or no).
#[must_use]
pub fn folder_name_refused(name: &str) -> bool {
    let trimmed = js_trim(name);
    trimmed.is_empty() || trimmed.contains('/') || utf16::len(trimmed) > DOCUMENT_NAME_MAX_LENGTH
}

/// `folderNameSchema`.
pub fn require_folder_name(name: &str) -> Result<(), IndexError> {
    require(!folder_name_refused(name))
}

/// `createDocumentInputSchema`.
pub fn check_create(
    workspace_id: &str,
    path: &str,
    kind: &str,
    name: Option<&str>,
) -> Result<(), IndexError> {
    require_id(workspace_id)?;
    require_path(path)?;
    require(matches!(kind, "spatial" | "markdown"))?;
    if let Some(name) = name {
        require(!name.is_empty())?;
        require_name(name)?;
    }
    Ok(())
}

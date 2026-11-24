//! Where a document's saved versions are kept (ADR-0029's history: a
//! version is a row the keeper holds beside the workspace record, never
//! inside it).

use std::future::Future;

use crate::{MaybeSend, PortError};

/// Who saved a version, as far as a reader is told: a person, an agent or
/// the keeper itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperatorKind {
    Ai,
    Human,
    System,
}

/// The party a version names, without the device and agent ids a person
/// never types; a keeper with no name to give answers none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionOperator {
    pub kind: OperatorKind,
    pub display_name: Option<String>,
}

/// One saved version of a document. A field the row does not hold is
/// absent, never a default.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedVersion {
    pub id: String,
    /// When it was saved, as `Date.prototype.toISOString` writes it: the
    /// keeper's own stamp, already in the form every surface publishes.
    pub created_at: String,
    pub label: Option<String>,
    /// An automatic checkpoint rather than one somebody saved.
    pub auto: bool,
    pub operator: Option<VersionOperator>,
    /// The version this point was produced by restoring, when it was.
    pub restored_from: Option<String>,
}

/// The version history a keeper holds: natively a table beside the record,
/// on Workers a Durable Object's storage. Only the listing is here; a save,
/// a checkout and a restore join with the operations that make them.
pub trait VersionStore {
    /// Every saved version of `document_id` in `workspace_id`, newest first
    /// (two saves in one millisecond: the later save first), or none for a
    /// document never saved. Whether the workspace holds the document is the
    /// caller's to have asked first.
    fn list(
        &self,
        workspace_id: &str,
        document_id: &str,
    ) -> impl Future<Output = Result<Vec<SavedVersion>, PortError>> + MaybeSend;
}

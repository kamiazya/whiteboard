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

/// What a save asks the keeper to record: a point somebody chose, under
/// their label, or an automatic checkpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewVersion {
    pub label: Option<String>,
    pub auto: bool,
}

/// The version history a keeper holds: natively a table beside the record,
/// on Workers a Durable Object's storage. The listing and the save are here;
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

    /// Records the document's state as it stands in the stored record as a
    /// new version of `document_id`, and answers it as `list` would list it.
    ///
    /// The keeper mints the id and the stamp, and names who saved it: the
    /// operation names nobody, so a save is the agent's (`kind: "ai"`, as the
    /// daemon's `agentVersionHistory` stamps an unnamed save). The keeper
    /// tells the document's watchers the version exists, and refuses a
    /// manual save once the document keeps as many manual versions as one
    /// document may (`TooManyVersions`), keeping nothing.
    fn save(
        &self,
        workspace_id: &str,
        document_id: &str,
        save: &NewVersion,
    ) -> impl Future<Output = Result<SavedVersion, PortError>> + MaybeSend;
}

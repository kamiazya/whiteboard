//! What a port answers when it cannot do what it was asked.
//!
//! Each variant is a failure the TypeScript ports name in
//! `packages/ports/src`, with the same message, so a caller that branched on
//! the class there branches on the variant here. The transport's status and
//! the MCP error are chosen from [`PortError::kind`] in the adapters, never
//! here: this crate knows no HTTP.

use std::fmt;

use whiteboard_det::date::InvalidTime;

/// Why a stored document could not be read back: the record is intact in a
/// shape this build does not know (the reader is old), damaged, or in an
/// envelope this keeper no longer reads. One says "update the app" and the
/// other "this document is damaged", so they are never folded into not-found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoredUnreadableCode {
    UnsupportedVersion,
    Malformed,
    RetiredEnvelope,
}

impl StoredUnreadableCode {
    /// The code as the TypeScript `StoredDocumentUnreadableError` spells it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::UnsupportedVersion => "unsupported-version",
            Self::Malformed => "malformed",
            Self::RetiredEnvelope => "retired-envelope",
        }
    }
}

/// Every way a chunk set can fail to reconstruct a snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotReassemblyCode {
    MissingChunk,
    ExtraChunk,
    DuplicateIndex,
    WrongOf,
    WrongByteLength,
    WrongTotalLength,
    EmptyChunkList,
    InvalidManifest,
}

impl SnapshotReassemblyCode {
    /// The code as the TypeScript `SnapshotReassemblyError` spells it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MissingChunk => "MISSING_CHUNK",
            Self::ExtraChunk => "EXTRA_CHUNK",
            Self::DuplicateIndex => "DUPLICATE_INDEX",
            Self::WrongOf => "WRONG_OF",
            Self::WrongByteLength => "WRONG_BYTE_LENGTH",
            Self::WrongTotalLength => "WRONG_TOTAL_LENGTH",
            Self::EmptyChunkList => "EMPTY_CHUNK_LIST",
            Self::InvalidManifest => "INVALID_MANIFEST",
        }
    }
}

/// The class of a [`PortError`], which is what an adapter maps to a status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortErrorKind {
    /// The workspace or document named does not exist.
    NotFound,
    /// Another process holds the database; the same call may succeed later.
    DatabaseBusy,
    /// A record is there and cannot be read back.
    Unreadable,
    /// A write would pass a bound on what a workspace or namespace may hold.
    Ceiling,
    /// A time value no JavaScript `Date` holds.
    InvalidTime,
}

/// A port's failure. Nothing of a refused write was kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortError {
    /// `WorkspaceNotFoundError`: workspaces never materialize implicitly, since
    /// a typo'd id is otherwise indistinguishable from a new one.
    WorkspaceNotFound { workspace_id: String },
    /// `DocumentNotFoundError`; `target` is the path or id the caller named.
    DocumentNotFound { workspace_id: String, target: String },
    /// A database another process holds locked (`SQLITE_BUSY`).
    DatabaseBusy,
    /// `StoredDocumentUnreadableError`.
    StoredDocumentUnreadable { code: StoredUnreadableCode, message: String },
    /// `SnapshotReassemblyError`.
    SnapshotReassembly { code: SnapshotReassemblyCode, message: String },
    /// `TooManyWorkspacesError`: the namespace already holds `limit`.
    TooManyWorkspaces { namespace: String, limit: usize },
    /// `TooManyDocumentsError`: the write would leave `documents`.
    TooManyDocuments { documents: usize, limit: usize },
    /// `TooManyFoldersError`: the write would leave `folders`.
    TooManyFolders { folders: usize, limit: usize },
    /// `TooManyVersionsError`: the document already keeps `limit` versions of
    /// the kind the save would add.
    TooManyVersions { limit: usize },
    /// A clock read no JavaScript `Date` holds.
    InvalidTime,
}

impl PortError {
    /// The class an adapter maps.
    #[must_use]
    pub const fn kind(&self) -> PortErrorKind {
        match self {
            Self::WorkspaceNotFound { .. } | Self::DocumentNotFound { .. } => {
                PortErrorKind::NotFound
            }
            Self::DatabaseBusy => PortErrorKind::DatabaseBusy,
            Self::StoredDocumentUnreadable { .. } | Self::SnapshotReassembly { .. } => {
                PortErrorKind::Unreadable
            }
            Self::TooManyWorkspaces { .. }
            | Self::TooManyDocuments { .. }
            | Self::TooManyFolders { .. }
            | Self::TooManyVersions { .. } => PortErrorKind::Ceiling,
            Self::InvalidTime => PortErrorKind::InvalidTime,
        }
    }

    /// The stable code a caller branches on: the one the TypeScript answers
    /// the same failure with, which `refusals.json` pins and
    /// `whiteboard-api-contracts` holds this to. A clock no `Date` holds is
    /// answered there as any uncaught throw.
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::WorkspaceNotFound { .. } => "workspace_not_found",
            Self::DocumentNotFound { .. } => "document_not_found",
            Self::DatabaseBusy => "database_busy",
            Self::StoredDocumentUnreadable {
                code: StoredUnreadableCode::UnsupportedVersion,
                ..
            } => "stored_document_unsupported_version",
            Self::StoredDocumentUnreadable { .. } | Self::SnapshotReassembly { .. } => {
                "corrupt_stored_data"
            }
            Self::TooManyWorkspaces { .. } => "too_many_workspaces",
            Self::TooManyDocuments { .. } => "too_many_documents",
            Self::TooManyFolders { .. } => "too_many_folders",
            Self::TooManyVersions { .. } => "too_many_versions",
            Self::InvalidTime => "internal_error",
        }
    }
}

impl fmt::Display for PortError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WorkspaceNotFound { workspace_id } => write!(
                f,
                "Workspace not found: \"{workspace_id}\". Create it before adding documents to it."
            ),
            Self::DocumentNotFound { workspace_id, target } => {
                write!(f, "No document \"{target}\" in workspace \"{workspace_id}\"")
            }
            Self::DatabaseBusy => f.write_str("The database is locked by another process"),
            Self::StoredDocumentUnreadable { message, .. }
            | Self::SnapshotReassembly { message, .. } => f.write_str(message),
            Self::TooManyWorkspaces { namespace, limit } => write!(
                f,
                "\"{namespace}\" already holds {limit} workspaces, the most one person may hold on this server"
            ),
            Self::TooManyDocuments { documents, limit } => write!(
                f,
                "This write would leave the workspace holding {documents} documents; a workspace holds at most {limit}. Move some documents to another workspace first"
            ),
            Self::TooManyFolders { folders, limit } => write!(
                f,
                "This write would leave the workspace holding {folders} folders; a workspace holds at most {limit}. Move or delete some folders' documents first"
            ),
            Self::TooManyVersions { limit } => write!(
                f,
                "This document already keeps {limit} saved versions, the most one document keeps; no further version can be saved for it"
            ),
            Self::InvalidTime => f.write_str("The clock read a time no Date holds"),
        }
    }
}

impl std::error::Error for PortError {}

impl From<InvalidTime> for PortError {
    fn from(_: InvalidTime) -> Self {
        Self::InvalidTime
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_arch = "wasm32")]
    use wasm_bindgen_test::wasm_bindgen_test as test;

    fn s(text: &str) -> String {
        text.to_owned()
    }

    type Row = (PortError, PortErrorKind, &'static str, String);

    /// Each variant a record or a lookup can fail with, and what the
    /// TypeScript class says for it.
    fn lookups() -> Vec<Row> {
        vec![
            (
                PortError::WorkspaceNotFound { workspace_id: s("w") },
                PortErrorKind::NotFound,
                "workspace_not_found",
                s("Workspace not found: \"w\". Create it before adding documents to it."),
            ),
            (
                PortError::DocumentNotFound { workspace_id: s("w"), target: s("a/b") },
                PortErrorKind::NotFound,
                "document_not_found",
                s("No document \"a/b\" in workspace \"w\""),
            ),
            (
                PortError::DatabaseBusy,
                PortErrorKind::DatabaseBusy,
                "database_busy",
                s("The database is locked by another process"),
            ),
            (
                PortError::StoredDocumentUnreadable {
                    code: StoredUnreadableCode::Malformed,
                    message: s("does not parse"),
                },
                PortErrorKind::Unreadable,
                "corrupt_stored_data",
                s("does not parse"),
            ),
            (
                PortError::SnapshotReassembly {
                    code: SnapshotReassemblyCode::MissingChunk,
                    message: s("chunk 2 of 3 is missing"),
                },
                PortErrorKind::Unreadable,
                "corrupt_stored_data",
                s("chunk 2 of 3 is missing"),
            ),
        ]
    }

    /// Each variant a write can be refused with.
    fn refusals() -> Vec<Row> {
        vec![
            (
                PortError::TooManyWorkspaces { namespace: s("ns"), limit: 1000 },
                PortErrorKind::Ceiling,
                "too_many_workspaces",
                s(
                    "\"ns\" already holds 1000 workspaces, the most one person may hold on this server",
                ),
            ),
            (
                PortError::TooManyDocuments { documents: 2001, limit: 2000 },
                PortErrorKind::Ceiling,
                "too_many_documents",
                s(
                    "This write would leave the workspace holding 2001 documents; a workspace holds at most 2000. Move some documents to another workspace first",
                ),
            ),
            (
                PortError::TooManyFolders { folders: 4001, limit: 4000 },
                PortErrorKind::Ceiling,
                "too_many_folders",
                s(
                    "This write would leave the workspace holding 4001 folders; a workspace holds at most 4000. Move or delete some folders' documents first",
                ),
            ),
            (
                PortError::TooManyVersions { limit: 200 },
                PortErrorKind::Ceiling,
                "too_many_versions",
                s(
                    "This document already keeps 200 saved versions, the most one document keeps; no further version can be saved for it",
                ),
            ),
            (
                PortError::InvalidTime,
                PortErrorKind::InvalidTime,
                "internal_error",
                s("The clock read a time no Date holds"),
            ),
        ]
    }

    #[test]
    fn every_variant_has_its_kind_code_and_message() {
        let all: Vec<Row> = lookups().into_iter().chain(refusals()).collect();
        assert_eq!(all.len(), 10);
        for (error, kind, code, message) in all {
            assert_eq!(error.kind(), kind, "{error:?}");
            assert_eq!(error.code(), code, "{error:?}");
            assert_eq!(error.to_string(), message, "{error:?}");
        }
    }

    #[test]
    fn the_unreadable_codes_are_the_ones_the_typescript_spells() {
        let stored = [
            (StoredUnreadableCode::UnsupportedVersion, "unsupported-version"),
            (StoredUnreadableCode::Malformed, "malformed"),
            (StoredUnreadableCode::RetiredEnvelope, "retired-envelope"),
        ];
        for (code, text) in stored {
            assert_eq!(code.as_str(), text);
            let error = PortError::StoredDocumentUnreadable { code, message: s("m") };
            let answered = if text == "unsupported-version" {
                "stored_document_unsupported_version"
            } else {
                "corrupt_stored_data"
            };
            assert_eq!(error.code(), answered);
        }
        let snapshot = [
            (SnapshotReassemblyCode::MissingChunk, "MISSING_CHUNK"),
            (SnapshotReassemblyCode::ExtraChunk, "EXTRA_CHUNK"),
            (SnapshotReassemblyCode::DuplicateIndex, "DUPLICATE_INDEX"),
            (SnapshotReassemblyCode::WrongOf, "WRONG_OF"),
            (SnapshotReassemblyCode::WrongByteLength, "WRONG_BYTE_LENGTH"),
            (SnapshotReassemblyCode::WrongTotalLength, "WRONG_TOTAL_LENGTH"),
            (SnapshotReassemblyCode::EmptyChunkList, "EMPTY_CHUNK_LIST"),
            (SnapshotReassemblyCode::InvalidManifest, "INVALID_MANIFEST"),
        ];
        for (code, text) in snapshot {
            assert_eq!(code.as_str(), text);
            let error = PortError::SnapshotReassembly { code, message: s("m") };
            assert_eq!(error.code(), "corrupt_stored_data");
        }
    }

    #[test]
    fn a_refused_time_converts_into_the_invalid_time_error() {
        assert_eq!(PortError::from(InvalidTime), PortError::InvalidTime);
        let boxed: Box<dyn std::error::Error> = Box::new(PortError::DatabaseBusy);
        assert_eq!(boxed.to_string(), "The database is locked by another process");
    }
}

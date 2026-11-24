//! `wb_version_save`: a labelled version of each document asked for, in one
//! hold of the workspace's write lock.

use whiteboard_api_contracts::Refusal;
use whiteboard_ports::{NewVersion, SavedVersion, VersionStore, WorkspaceLock};

use crate::document_resolve::resolve_in;
use crate::record::open_record;
use crate::{Contract, Operation, Ports, Row};

/// The workspace, already resolved to its canonical id, the documents in the
/// order asked (a repeated one saved again), and the one label they share.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionSaveInput {
    pub workspace_id: String,
    pub document_ids: Vec<String>,
    pub label: String,
}

/// One saved version per document asked for, in the order asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionSaveOutput {
    pub saved: Vec<SavedDocumentVersion>,
}

/// A document and the version saved of it, as the store answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedDocumentVersion {
    pub document_id: String,
    pub version: SavedVersion,
}

/// `createVersionSaveTool`'s execute, which only `wb_version_save` calls.
#[derive(Debug, Clone, Copy)]
pub struct VersionSave;

impl Operation for VersionSave {
    type Input = VersionSaveInput;
    type Output = VersionSaveOutput;

    const ROW: Row = Row {
        name: "versionSave",
        tool: Some("wb_version_save"),
        route: None,
        input: Contract { schema: "versionSaveInputSchema" },
        output: Contract { schema: "versionSaveOutputSchema" },
    };

    /// Every document is resolved before any is saved: there is no
    /// transaction across documents, so a batch naming one the workspace
    /// does not hold is refused having written nothing. A store failing part
    /// way keeps what it saved before, which no ordering can undo.
    async fn execute<P: Ports>(
        ports: &P,
        input: VersionSaveInput,
    ) -> Result<VersionSaveOutput, Refusal> {
        let VersionSaveInput { workspace_id, document_ids, label } = input;
        let _held = ports.lock().lock(&workspace_id).await;
        let record = open_record(ports.records(), &workspace_id)
            .await
            .map_err(|error| Refusal::from(&error))?;
        for document_id in &document_ids {
            resolve_in(&record, &workspace_id, document_id)?;
        }
        let asked = NewVersion { label: Some(label), auto: false, restored_from: None };
        let mut saved = Vec::with_capacity(document_ids.len());
        for document_id in document_ids {
            let version = ports
                .versions()
                .save(&workspace_id, &document_id, &asked)
                .await
                .map_err(|error| Refusal::from(&error))?;
            saved.push(SavedDocumentVersion { document_id, version });
        }
        Ok(VersionSaveOutput { saved })
    }
}

#[cfg(test)]
mod tests;

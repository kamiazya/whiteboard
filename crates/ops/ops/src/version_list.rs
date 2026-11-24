//! `wb_version_list`: a document's saved versions, newest first.

use whiteboard_api_contracts::Refusal;
use whiteboard_ports::{SavedVersion, VersionStore};

use crate::{Contract, DocumentResolve, DocumentResolveInput, Operation, Ports, Row};

/// The workspace, already resolved to its canonical id, and the document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionListInput {
    pub workspace_id: String,
    pub document_id: String,
}

/// The document asked about and its history as the store lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionListOutput {
    pub document_id: String,
    pub versions: Vec<SavedVersion>,
}

/// `createVersionListTool`'s execute, which only `wb_version_list` calls.
#[derive(Debug, Clone, Copy)]
pub struct VersionList;

impl Operation for VersionList {
    type Input = VersionListInput;
    type Output = VersionListOutput;

    const ROW: Row = Row {
        name: "versionList",
        tool: Some("wb_version_list"),
        route: None,
        input: Contract { schema: "versionListInputSchema" },
        output: Contract { schema: "versionListOutputSchema" },
    };

    /// The document is resolved in the workspace first, so a document the
    /// workspace does not hold is refused as that rather than listed as a
    /// document never saved.
    async fn execute<P: Ports>(
        ports: &P,
        input: VersionListInput,
    ) -> Result<VersionListOutput, Refusal> {
        let VersionListInput { workspace_id, document_id } = input;
        let resolve = DocumentResolveInput { workspace_id: workspace_id.clone(), document_id };
        let entry = DocumentResolve::execute(ports, resolve).await?;
        let versions = ports
            .versions()
            .list(&workspace_id, &entry.document_id)
            .await
            .map_err(|error| Refusal::from(&error))?;
        Ok(VersionListOutput { document_id: entry.document_id, versions })
    }
}

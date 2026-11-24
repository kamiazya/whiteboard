//! `wbDocumentList`: every document of a workspace, with its pins and the
//! names its folders show.

use std::collections::BTreeSet;

use whiteboard_api_contracts::Refusal;
use whiteboard_ports::PortError;
use whiteboard_workspace_index::{
    WorkspaceRecord, list_documents, list_folder_names, list_pinned_documents,
};

use crate::record::open_record;
use crate::{Contract, DocumentDetail, Method, Operation, Ports, Route, Row};

/// The workspace, already resolved to its canonical id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentListInput {
    pub workspace_id: String,
}

/// One document of a listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedDocument {
    pub detail: DocumentDetail,
    /// Whether the workspace pins it; a record always keeps pins, so this is
    /// never absent here.
    pub pinned: bool,
}

/// A folder that has a display name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderName {
    pub path: String,
    pub name: String,
}

/// Every document in the port's path order, and the named folders in the
/// same order (none written when empty).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentListOutput {
    pub documents: Vec<ListedDocument>,
    pub folder_names: Vec<FolderName>,
}

/// `wbDocumentList`, behind `wb_document_list` and the `/api/v1` listing.
#[derive(Debug, Clone, Copy)]
pub struct DocumentList;

impl Operation for DocumentList {
    type Input = DocumentListInput;
    type Output = DocumentListOutput;

    const ROW: Row = Row {
        name: "wbDocumentList",
        tool: Some("wb_document_list"),
        route: Some(Route {
            method: Method::Get,
            path: "/api/v1/workspaces/:workspaceId/documents",
        }),
        input: Contract { schema: "wbDocumentListInputSchema" },
        output: Contract { schema: "wbDocumentListOutputSchema" },
    };

    async fn execute<P: Ports>(
        ports: &P,
        input: DocumentListInput,
    ) -> Result<DocumentListOutput, Refusal> {
        let record = open_record(ports.records(), &input.workspace_id)
            .await
            .map_err(|error| refusal_for_read(&error))?;
        listing(&record)
    }
}

/// An unknown workspace in the advice for a read, as the tool surface words
/// it; any other failure as the port's own refusal.
fn refusal_for_read(error: &PortError) -> Refusal {
    match error {
        PortError::WorkspaceNotFound { workspace_id } => {
            Refusal::WorkspaceNotFoundForCallerRead { workspace_id: workspace_id.clone() }
        }
        other => Refusal::from(other),
    }
}

fn listing(record: &WorkspaceRecord) -> Result<DocumentListOutput, Refusal> {
    // A stamp no `Date` holds throws from `toISOString` there, an uncaught
    // throw.
    let entries = list_documents(record).map_err(|_| Refusal::from(&PortError::InvalidTime))?;
    let pinned: BTreeSet<String> = list_pinned_documents(record).into_iter().collect();
    let documents = entries
        .into_iter()
        .map(|entry| {
            let pinned = pinned.contains(&entry.document_id);
            ListedDocument { detail: DocumentDetail::of(entry), pinned }
        })
        .collect();
    let folder_names = list_folder_names(record)
        .into_iter()
        .map(|(path, name)| FolderName { path, name })
        .collect();
    Ok(DocumentListOutput { documents, folder_names })
}

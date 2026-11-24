//! `wbDocumentResolve`: one document of a workspace, by id.

use whiteboard_api_contracts::Refusal;
use whiteboard_ports::PortError;
use whiteboard_workspace_index::{DocumentEntry, WorkspaceRecord, resolve_document_by_id};

use crate::record::open_record;
use crate::{Contract, Method, Operation, Ports, Route, Row};

/// The workspace, already resolved to its canonical id, and the document's id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentResolveInput {
    pub workspace_id: String,
    pub document_id: String,
}

/// What a listing and a resolve say of one document; an absent field is one
/// the record does not hold, never a guess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentDetail {
    pub document_id: String,
    pub path: String,
    pub name: Option<String>,
    pub kind: Option<String>,
    pub updated_at: Option<String>,
    /// The losing side of a path two replicas created; written only when true.
    pub shadowed: bool,
}

impl DocumentDetail {
    pub(crate) fn of(entry: DocumentEntry) -> Self {
        Self {
            document_id: entry.document_id,
            path: entry.path,
            name: entry.name,
            kind: entry.kind,
            updated_at: entry.updated_at,
            shadowed: entry.shadowed == Some(true),
        }
    }
}

/// `wbDocumentResolve`, which only the `/api/v1` route calls.
#[derive(Debug, Clone, Copy)]
pub struct DocumentResolve;

impl Operation for DocumentResolve {
    type Input = DocumentResolveInput;
    type Output = DocumentDetail;

    const ROW: Row = Row {
        name: "wbDocumentResolve",
        tool: None,
        route: Some(Route {
            method: Method::Get,
            path: "/api/v1/workspaces/:workspaceId/documents/:documentId",
        }),
        input: Contract { schema: "wbDocumentResolveInputSchema" },
        output: Contract { schema: "wbDocumentResolveOutputSchema" },
    };

    async fn execute<P: Ports>(
        ports: &P,
        input: DocumentResolveInput,
    ) -> Result<DocumentDetail, Refusal> {
        let record = open_record(ports.records(), &input.workspace_id)
            .await
            .map_err(|error| Refusal::from(&error))?;
        let entry = resolve_in(&record, &input.workspace_id, &input.document_id)?;
        Ok(DocumentDetail::of(entry))
    }
}

/// `document_id` in the open record of `workspace_id`, or the refusal an MCP
/// caller is given for a document the workspace does not hold.
pub(crate) fn resolve_in(
    record: &WorkspaceRecord,
    workspace_id: &str,
    document_id: &str,
) -> Result<DocumentEntry, Refusal> {
    // A stamp no `Date` holds throws from `toISOString` there, an uncaught
    // throw.
    let found = resolve_document_by_id(record, document_id)
        .map_err(|_| Refusal::from(&PortError::InvalidTime))?;
    found.ok_or_else(|| Refusal::DocumentNotFound {
        document_id: document_id.to_owned(),
        workspace_id: workspace_id.to_owned(),
    })
}

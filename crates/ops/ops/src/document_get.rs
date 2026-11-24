//! `documentGet`: one or more documents of a workspace, each in its own
//! format, with the annotation layer it carries, inside one response budget
//! (server-core's `createDocumentGetTool`).
//!
//! A per-document failure is reported beside the documents that read; a
//! systemic one refuses the call. Each failure's reason is the error's own
//! message, which is what both TypeScript roots answer for the two this
//! operation reports (`reportedFaultText`: the local daemon's
//! `describeThrown`, and server mode's, which passes a named refusal
//! verbatim), so no root supplies it.
//!
//! What this crate cannot answer yet is [`Pending`]: a canvas the JSON Canvas
//! writer declines and a frontmatter the OKF writer refuses (whose words are
//! the TypeScript shim's), and a read the record leaves to its caller.

mod budget;
mod engine;
mod markdown;
mod spatial;

use std::collections::BTreeSet;

use whiteboard_api_contracts::Refusal;
use whiteboard_model::Value;
use whiteboard_model::crdt::QueryName;
use whiteboard_ports::PortError;
use whiteboard_workspace_index::{WorkspaceRecord, resolve_document_by_id};

use crate::record::open_record;
use crate::{Contract, Operation, Ports, Row};
use budget::Budget;
use engine::{Fault, Hosted, defined};

/// The workspace, already resolved to its canonical id, and what to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentGetInput {
    pub workspace_id: String,
    /// In the order asked; a repeat is read once, where it first appears.
    pub document_ids: Vec<String>,
    /// `options.strict`: a spatial document as JSON Canvas 1.0 alone. It
    /// chooses that writer's mode and nothing else, so a markdown read never
    /// sees it.
    pub strict: bool,
}

/// One document as read: its content in its own format and its annotation
/// layer, an empty list being one the document does not hold.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadDocument {
    pub document_id: String,
    pub kind: String,
    pub content: String,
    /// The OKF frontmatter, for a markdown document.
    pub frontmatter: Option<Value>,
    pub threads: Vec<Value>,
    pub proposals: Vec<Value>,
    /// Its annotation layer was trimmed to fit the budget.
    pub annotations_truncated: bool,
}

/// A document this call could not read, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedRead {
    pub document_id: String,
    pub reason: String,
}

/// The documents read, in the order asked, and those that were not.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct DocumentGetOutput {
    pub documents: Vec<ReadDocument>,
    pub failed: Vec<FailedRead>,
}

/// What this crate does not answer yet, naming the document it met it at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pending {
    /// A spatial document's canvas the JSON Canvas writer declines: past the
    /// wire's cap or depth, no canvas once lifted, or a value the writer has
    /// no spelling for.
    JsonCanvasDeclined(String),
    /// A frontmatter the OKF writer has no spelling for.
    OkfUnwritable(String),
    /// A content read the workspace record leaves to its caller.
    UndecidedRead(String),
}

/// The call's answer, or the part of it this crate does not answer yet.
#[derive(Debug, Clone, PartialEq)]
pub enum DocumentGetAnswer {
    Read(DocumentGetOutput),
    Pending(Pending),
}

/// Why a call stops before answering.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Stop {
    Refused(Refusal),
    Pending(Pending),
}

/// `documentGet`, behind `wb_document_get` alone.
#[derive(Debug, Clone, Copy)]
pub struct DocumentGet;

impl Operation for DocumentGet {
    type Input = DocumentGetInput;
    type Output = DocumentGetAnswer;

    const ROW: Row = Row {
        name: "documentGet",
        tool: Some("wb_document_get"),
        route: None,
        input: Contract { schema: "documentGetInputSchema" },
        output: Contract { schema: "documentGetOutputSchema" },
    };

    async fn execute<P: Ports>(
        ports: &P,
        input: DocumentGetInput,
    ) -> Result<DocumentGetAnswer, Refusal> {
        let record = open_record(ports.records(), &input.workspace_id)
            .await
            .map_err(|error| Refusal::from(&error))?;
        match read_all(&record, input.document_ids, input.strict) {
            Ok(output) => Ok(DocumentGetAnswer::Read(output)),
            Err(Stop::Pending(pending)) => Ok(DocumentGetAnswer::Pending(pending)),
            Err(Stop::Refused(refusal)) => Err(refusal),
        }
    }
}

/// Each document once, in order, until the budget is spent; every one after
/// that is reported unread without being read.
fn read_all(
    record: &WorkspaceRecord,
    ids: Vec<String>,
    strict: bool,
) -> Result<DocumentGetOutput, Stop> {
    let mut seen = BTreeSet::new();
    let mut budget = Budget::default();
    for document_id in ids {
        if !seen.insert(document_id.clone()) {
            continue;
        }
        if budget.spent() {
            budget.unread(document_id);
            continue;
        }
        match read_one(Hosted { record, document_id: &document_id }, strict)? {
            Ok(read) => budget.offer(read),
            Err(reason) => budget.fail(FailedRead { document_id, reason }),
        }
    }
    Ok(budget.finish())
}

/// One document, or the reason it was not read.
fn read_one(hosted: Hosted<'_>, strict: bool) -> Result<Result<ReadDocument, String>, Stop> {
    let id = hosted.document_id;
    // A stamp no `Date` holds throws from `toISOString` there.
    let found = resolve_document_by_id(hosted.record, id)
        .map_err(|_| Stop::Refused(Refusal::from(&PortError::InvalidTime)))?;
    let Some(entry) = found else {
        return Ok(Err(format!(
            "Document not found: {id}. This workspace holds no document with that id; wb_document_list shows the ones it does."
        )));
    };
    match read_known(hosted, entry.kind, entry.name.as_deref(), strict) {
        Ok(read) => Ok(read),
        Err(Fault::Retired(found)) => Ok(Err(Refusal::RetiredStoredShape { found }.message())),
        Err(Fault::Stop(stop)) => Err(stop),
    }
}

/// The document read in the format its kind names, the kind its own content
/// records or, failing that, its index row's: a markdown document as OKF
/// Markdown, any other as JSON Canvas.
fn read_known(
    hosted: Hosted<'_>,
    indexed_kind: Option<String>,
    name: Option<&str>,
    strict: bool,
) -> Result<Result<ReadDocument, String>, Fault> {
    let stated = defined(hosted.read(QueryName::DocumentKind, &[])?);
    let threads = items(hosted.read(QueryName::Annotations, &[])?);
    let proposals = items(hosted.read(QueryName::Proposals, &[])?);
    let Some(kind) = kind_of(stated, indexed_kind) else {
        return Ok(Err(kind_unknown(hosted.document_id)));
    };
    let (content, frontmatter) = if kind == "markdown" {
        let exported = markdown::export(hosted, name)?;
        (exported.markdown, Some(exported.frontmatter))
    } else {
        match spatial::export(hosted, strict)? {
            Ok(json) => (json, None),
            Err(reason) => return Ok(Err(reason)),
        }
    };
    Ok(Ok(ReadDocument {
        document_id: hosted.document_id.to_owned(),
        kind,
        content,
        frontmatter,
        threads,
        proposals,
        annotations_truncated: false,
    }))
}

/// The kind the document states, else its index row's: a read-only fallback
/// for a document created before kinds, never written back.
fn kind_of(stated: Option<Value>, indexed: Option<String>) -> Option<String> {
    match stated {
        Some(Value::String(kind)) => Some(kind),
        _ => indexed,
    }
}

fn items(value: Value) -> Vec<Value> {
    match value {
        Value::Seq(items) => items,
        _ => Vec::new(),
    }
}

fn kind_unknown(document_id: &str) -> String {
    format!(
        "Document {document_id} records no kind, so there is no format to read it as (checked both the document itself and its index row). Documents created before kinds existed are affected. Editing one records a kind: wb_canvas_edit records it as spatial and keeps what it holds, and `wb_workspace_edit`'s `document.set` op records it as markdown — which replaces its content, so it is refused unless the document is empty."
    )
}

#[cfg(test)]
mod tests;

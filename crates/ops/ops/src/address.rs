//! Where a caller's workspace ADDRESS becomes the canonical id an operation
//! keys on, once, before the operation runs (server-core's
//! `withResolvedWorkspaceHandles` over `resolveWorkspaceHandle`).
//!
//! Once is the load-bearing word: a lock, a cache and a sync key all key on
//! the resolved id, and two resolutions of one request could disagree.

use std::future::Future;

use whiteboard_api_contracts::Refusal;
use whiteboard_model::checks::canonical_ulid;
use whiteboard_ports::{Caller, PortError, WorkspaceEntry, WorkspaceLookup, WorkspaceRegistry};
use whiteboard_workspace_index::document_path::is_workspace_segment;

use crate::Ports;

/// The three forms an address takes (ADR-0053). Parsing decides only the
/// form; which workspace it names is the registry's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceAddress {
    /// A canonical id, naming its workspace whatever namespace holds it.
    Id(String),
    /// A segment inside the namespace `namespace` names.
    Qualified { namespace: String, segment: String },
    /// A segment in the caller's own namespace.
    Bare(String),
}

/// The address `input` spells, or `None` when it spells none of the three
/// forms (`parseWorkspaceAddress`). A segment is never shaped like a ULID, so
/// a bare one cannot read back as an id.
#[must_use]
pub fn parse_workspace_address(input: &str) -> Option<WorkspaceAddress> {
    if let Some((namespace, segment)) = input.split_once('/') {
        return (is_workspace_segment(namespace) && is_workspace_segment(segment)).then(|| {
            WorkspaceAddress::Qualified {
                namespace: namespace.to_owned(),
                segment: segment.to_owned(),
            }
        });
    }
    if canonical_ulid(input) {
        return Some(WorkspaceAddress::Id(input.to_owned()));
    }
    is_workspace_segment(input).then(|| WorkspaceAddress::Bare(input.to_owned()))
}

/// The lookup `handle` means for a caller in `caller_namespace`, or `None`
/// when it is no address.
fn lookup_of(handle: &str, caller_namespace: String) -> Option<WorkspaceLookup> {
    Some(match parse_workspace_address(handle)? {
        WorkspaceAddress::Id(id) => WorkspaceLookup::Id(id),
        WorkspaceAddress::Qualified { namespace, segment } => {
            WorkspaceLookup::Segment { namespace, segment }
        }
        WorkspaceAddress::Bare(segment) => {
            WorkspaceLookup::Segment { namespace: caller_namespace, segment }
        }
    })
}

/// The workspace `handle` names for the caller, or `None` when nothing
/// answers to it (`resolveWorkspaceFor`). The caller's namespace is asked
/// whatever form the handle takes, as the TypeScript asks it.
///
/// # Errors
///
/// The caller's or the registry's own failure.
pub async fn resolve_workspace<P: Ports>(
    ports: &P,
    handle: &str,
) -> Result<Option<WorkspaceEntry>, PortError> {
    let namespace = ports.caller().namespace().await?;
    match lookup_of(handle, namespace) {
        Some(lookup) => ports.registry().find(&lookup).await,
        None => Ok(None),
    }
}

/// The advice-bearing refusal of a read for a workspace nothing answers to,
/// naming the workspaces the caller may see when the keeper says which.
pub(crate) async fn unknown_workspace<P: Ports>(ports: &P, handle: String) -> Refusal {
    unknown_workspace_for(ports, handle, false).await
}

/// [`unknown_workspace`], advising a call that `creates` a document to pass
/// `createWorkspace` instead (`WorkspaceNotFoundForCallerError`'s intent).
pub(crate) async fn unknown_workspace_for<P: Ports>(
    ports: &P,
    handle: String,
    creates: bool,
) -> Refusal {
    let known = match ports.caller().known_workspace_handles().await {
        Ok(known) => known.filter(|known| !known.is_empty()),
        Err(error) => return Refusal::from(&error),
    };
    match (known, creates) {
        (Some(known), false) => {
            Refusal::WorkspaceNotFoundForCallerReadKnown { known, workspace_id: handle }
        }
        (None, false) => Refusal::WorkspaceNotFoundForCallerRead { workspace_id: handle },
        (Some(known), true) => {
            Refusal::WorkspaceNotFoundForCallerCreateKnown { known, workspace_id: handle }
        }
        (None, true) => Refusal::WorkspaceNotFoundForCallerCreate { workspace_id: handle },
    }
}

/// Runs `operation` over the canonical id `handle` resolves to, and answers
/// its refusal in the words the caller used.
///
/// # Errors
///
/// An address nothing answers to, refused as a read refuses it; the caller's
/// or the registry's failure; and the operation's own refusal.
pub async fn with_resolved_workspace<P, T, F>(
    ports: &P,
    handle: &str,
    operation: impl FnOnce(String) -> F,
) -> Result<T, Refusal>
where
    P: Ports,
    F: Future<Output = Result<T, Refusal>>,
{
    let resolved = resolve_workspace(ports, handle).await.map_err(|error| Refusal::from(&error))?;
    let Some(entry) = resolved else {
        return Err(unknown_workspace(ports, handle.to_owned()).await);
    };
    let workspace_id = entry.workspace_id;
    operation(workspace_id.clone())
        .await
        .map_err(|refusal| in_callers_words(refusal, &workspace_id, handle))
}

/// A refusal quoting the canonical id, re-said with the handle the caller
/// typed (`inTheCallersWords`): a caller who addressed a workspace by segment
/// never typed its id, so a refusal quoting it names nothing they can check.
///
/// ponytail: the refusals whose text an operation here can fill with the id,
/// listed by hand; a variant joins as an operation answers it, or a mapping
/// generated over every refusal's text replaces the list when one is worth it.
pub(crate) fn in_callers_words(refusal: Refusal, workspace_id: &str, handle: &str) -> Refusal {
    let said = |text: String| text.replace(workspace_id, handle);
    match refusal {
        Refusal::WorkspaceNotFoundForCallerRead { workspace_id } => {
            Refusal::WorkspaceNotFoundForCallerRead { workspace_id: said(workspace_id) }
        }
        Refusal::WorkspaceNotFoundForCallerReadKnown { known, workspace_id } => {
            Refusal::WorkspaceNotFoundForCallerReadKnown {
                known: known.into_iter().map(said).collect(),
                workspace_id: said(workspace_id),
            }
        }
        Refusal::DocumentNotFound { document_id, workspace_id } => Refusal::DocumentNotFound {
            document_id: said(document_id),
            workspace_id: said(workspace_id),
        },
        Refusal::CorruptStoredData { message } => {
            Refusal::CorruptStoredData { message: said(message) }
        }
        Refusal::StoredDocumentUnsupportedVersion { message } => {
            Refusal::StoredDocumentUnsupportedVersion { message: said(message) }
        }
        Refusal::WorkspaceEditOpRefused { op_index, op, applied, detail } => {
            Refusal::WorkspaceEditOpRefused { op_index, op, applied, detail: said(detail) }
        }
        other => other,
    }
}

#[cfg(test)]
mod tests;

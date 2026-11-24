//! `wb_version_restore`: a document put back to one of its saved versions, as
//! server-core's `restoreVersion` does under one hold of the workspace's
//! write lock.
//!
//! Answered here: every refusal of the three modes, and the restore in
//! place, whose result is a new edit equal to the saved state. What is not
//! answered yet is [`RestorePending`]: a restore into another path and a
//! subtree rollback once nothing refuses them, a write the content sync
//! declines (one that changes more than one of a document's roots, whose
//! order the TypeScript takes from wasm32's hash map), and a version id the
//! daemon's keeper refuses in words no contract holds yet.

mod write;

use whiteboard_api_contracts::Refusal;
use whiteboard_crdt::{DocumentKind, LoroDoc, document_kind, import_bytes, judge_state};
use whiteboard_ports::{
    ClientNotifier, Clock, DocumentWritten, IdMint, NewVersion, PortError, RestorePhase,
    RestoreProgress, VersionStore, WorkspaceLock, WorkspaceRecordStore, WriteObserver,
};
use whiteboard_workspace_index::WorkspaceRecord;
use whiteboard_workspace_index::document_path::is_document_path;

use crate::document_resolve::resolve_in;
use crate::record::load_record;
use crate::text_refusal::text_breach_refusal;
use crate::{Contract, Operation, Ports, Row};

/// The workspace, already resolved to its canonical id, the document whose
/// history holds the version, the version, and the mode's arguments as given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionRestoreInput {
    pub workspace_id: String,
    pub document_id: String,
    pub version_id: String,
    pub target_path: Option<String>,
    pub overwrite: Option<bool>,
    pub subtree: Option<bool>,
}

/// A restore in place: the document addressed, the version, and its label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionRestored {
    pub document_id: String,
    pub restored_version_id: String,
    pub label: Option<String>,
}

/// What this crate does not answer yet, which a binding answers as a pending
/// tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestorePending {
    /// A restore into another path that nothing refuses.
    IntoTarget,
    /// A subtree rollback that nothing refuses.
    Subtree,
    /// A version id the daemon's keeper refuses (`validateVersionId`), in
    /// words no contract holds.
    UnnamedVersionId,
    /// A past state the judge or the content sync could not read.
    Unreadable,
    /// A write the content sync declines: more than one root changed.
    Declined,
}

/// The call's answer, or the part of it this crate does not answer yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionRestoreAnswer {
    Restored(VersionRestored),
    Pending(RestorePending),
}

/// `createVersionRestoreTool`'s execute, which only `wb_version_restore` calls.
#[derive(Debug, Clone, Copy)]
pub struct VersionRestore;

/// Why a restore stops before answering.
enum Stop {
    Refused(Refusal),
    Pending(RestorePending),
}

impl From<Refusal> for Stop {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<&PortError> for Stop {
    fn from(error: &PortError) -> Self {
        Self::Refused(Refusal::from(error))
    }
}

impl Operation for VersionRestore {
    type Input = VersionRestoreInput;
    type Output = VersionRestoreAnswer;

    const ROW: Row = Row {
        name: "versionRestore",
        tool: Some("wb_version_restore"),
        route: None,
        input: Contract { schema: "versionRestoreInputSchema" },
        output: Contract { schema: "versionRestoreOutputSchema" },
    };

    async fn execute<P: Ports>(
        ports: &P,
        input: VersionRestoreInput,
    ) -> Result<VersionRestoreAnswer, Refusal> {
        let _held = ports.lock().lock(&input.workspace_id).await;
        match restore(ports, &input).await {
            Ok(label) => Ok(VersionRestoreAnswer::Restored(VersionRestored {
                document_id: input.document_id,
                restored_version_id: input.version_id,
                label,
            })),
            Err(Stop::Refused(refusal)) => Err(refusal),
            Err(Stop::Pending(pending)) => Ok(VersionRestoreAnswer::Pending(pending)),
        }
    }
}

/// `PATH_SAFE_ID_PATTERN` within the 64 characters the daemon's
/// `validateVersionId` holds a version id to.
fn keeper_names(version_id: &str) -> bool {
    (1..=64).contains(&version_id.len())
        && version_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// What every mode has in hand once the version is the document's own.
struct Past<'a> {
    workspace_id: &'a str,
    document_id: &'a str,
    version_id: &'a str,
    label: Option<String>,
    bytes: Vec<u8>,
    doc: LoroDoc,
}

/// `VersionNotFoundError`: no version by that id in the document's history.
fn not_found(document_id: &str, version_id: &str) -> Refusal {
    Refusal::VersionNotFound {
        document_id: document_id.to_owned(),
        version_id: version_id.to_owned(),
    }
}

/// The restore, answering the version's label once it landed.
async fn restore<P: Ports>(ports: &P, input: &VersionRestoreInput) -> Result<Option<String>, Stop> {
    let ws = input.workspace_id.as_str();
    let (bytes, record) = load_record(ports.records(), ws).await.map_err(|e| Stop::from(&e))?;
    let entry = resolve_in(&record, ws, &input.document_id)?;
    let not_found = || Stop::Refused(not_found(&input.document_id, &input.version_id));
    if !keeper_names(&input.version_id) {
        return Err(Stop::Pending(RestorePending::UnnamedVersionId));
    }
    let history =
        ports.versions().list(ws, &entry.document_id).await.map_err(|e| Stop::from(&e))?;
    let past_bytes = ports
        .versions()
        .load(ws, &input.version_id)
        .await
        .map_err(|e| Stop::from(&e))?
        .ok_or_else(not_found)?;
    // A version id is unique per workspace, so the history named has to hold
    // it: another document's version is, to this caller, none.
    let owned = history.into_iter().find(|v| v.id == input.version_id).ok_or_else(not_found)?;
    let doc = import_bytes(&past_bytes).map_err(|_| Stop::Pending(RestorePending::Unreadable))?;
    let past = Past {
        workspace_id: ws,
        document_id: &input.document_id,
        version_id: &input.version_id,
        label: owned.label,
        bytes: past_bytes,
        doc,
    };
    let path = entry.path.as_str();
    match input.target_path.as_deref() {
        Some(target) if target != path => into_target(ports, &record, &past, path, target, input),
        _ if input.subtree == Some(true) => {
            let versions = ports.versions();
            let at = versions.load_workspace_at(ws, &input.version_id).await;
            match at.map_err(|error| Stop::from(&error))? {
                None => Err(Stop::Refused(Refusal::SubtreeNeedsWorkspaceVersion {
                    version_id: input.version_id.clone(),
                })),
                Some(_) => Err(Stop::Pending(RestorePending::Subtree)),
            }
        }
        _ => in_place(ports, &bytes, &record, past, path).await,
    }
}

/// The kind the record records for the document at `path`.
fn kind_at(record: &WorkspaceRecord, path: &str) -> Option<String> {
    record.placed_document_at(path).map(|placed| placed.meta.kind)
}

const fn kind_name(kind: DocumentKind) -> &'static str {
    match kind {
        DocumentKind::Spatial => "spatial",
        DocumentKind::Markdown => "markdown",
    }
}

/// `withinSyncLimits`: the refusal of writing `past` whole at `path`, which
/// records `recorded` — a limit the sync surface enforces, then an envelope
/// stating another kind.
fn judged(past: &LoroDoc, path: &str, recorded: Option<&str>) -> Result<Option<Refusal>, Stop> {
    if let Some(breach) =
        judge_state(past).map_err(|_| Stop::Pending(RestorePending::Unreadable))?
    {
        return Ok(Some(text_breach_refusal(&breach, path)));
    }
    let stated = document_kind(past).map(kind_name);
    Ok(match (recorded, stated) {
        (Some(recorded), Some(stated)) if recorded != stated => {
            Some(Refusal::DocumentKindChangedUnnamedKind {
                kind: stated.to_owned(),
                recorded: recorded.to_owned(),
            })
        }
        _ => None,
    })
}

/// A page told a restore of `path` began and, at once, ended, around a
/// refusal that wrote nothing.
fn refused_between<N: ClientNotifier>(
    notifier: &N,
    past: &Past<'_>,
    path: &str,
    refusal: Refusal,
) -> Stop {
    notify(notifier, past, path, RestorePhase::Started);
    notify(notifier, past, path, RestorePhase::Complete);
    Stop::Refused(refusal)
}

fn notify<N: ClientNotifier>(notifier: &N, past: &Past<'_>, path: &str, phase: RestorePhase) {
    let label = match phase {
        RestorePhase::Started => past.label.clone(),
        RestorePhase::Complete => None,
    };
    notifier.restore_progress(&RestoreProgress {
        workspace_id: past.workspace_id.to_owned(),
        path: path.to_owned(),
        phase,
        label,
    });
}

/// Tells a page the restore of `path` ended, exactly once, when dropped.
struct Ended<'a, N: ClientNotifier> {
    notifier: &'a N,
    workspace_id: &'a str,
    path: &'a str,
}

impl<N: ClientNotifier> Drop for Ended<'_, N> {
    fn drop(&mut self) {
        self.notifier.restore_progress(&RestoreProgress {
            workspace_id: self.workspace_id.to_owned(),
            path: self.path.to_owned(),
            phase: RestorePhase::Complete,
            label: None,
        });
    }
}

/// `restoreToTarget`, refusals only: a target past the grammar, a subtree
/// asked to land elsewhere, an existing target without `overwrite`, one of
/// the other kind, and a past the target could not take.
fn into_target<P: Ports>(
    ports: &P,
    record: &WorkspaceRecord,
    past: &Past<'_>,
    path: &str,
    target: &str,
    input: &VersionRestoreInput,
) -> Result<Option<String>, Stop> {
    if !is_document_path(target) {
        return Err(Refusal::InvalidRestoreTargetPath { target_path: target.to_owned() }.into());
    }
    if input.subtree == Some(true) {
        return Err(Refusal::SubtreeTakesNoTarget.into());
    }
    let source_kind = kind_at(record, path);
    if record.placed_document_at(target).is_none() {
        // A new document carries the source's kind.
        return match judged(&past.doc, target, source_kind.as_deref())? {
            Some(refusal) => Err(refusal.into()),
            None => Err(Stop::Pending(RestorePending::IntoTarget)),
        };
    }
    if input.overwrite != Some(true) {
        return Err(Refusal::RestoreTargetExists { target_path: target.to_owned() }.into());
    }
    let target_kind = kind_at(record, target);
    if let (Some(source), Some(held)) = (&source_kind, &target_kind)
        && source != held
    {
        let detail = if held == "spatial" {
            "Restoring a markdown version onto it would replace its nodes and edges with a markdown body. Restore into a new targetPath instead."
        } else {
            "Restoring a spatial version onto it would replace its markdown body with a canvas. Restore into a new targetPath instead."
        };
        return Err(Refusal::DocumentKindMismatch {
            detail: detail.to_owned(),
            document_id: target.to_owned(),
            kind: held.clone(),
        }
        .into());
    }
    let recorded = target_kind.or(source_kind);
    match judged(&past.doc, target, recorded.as_deref())? {
        Some(refusal) => Err(refused_between(ports.notifier(), past, target, refusal)),
        None => Err(Stop::Pending(RestorePending::IntoTarget)),
    }
}

/// `restoreInPlace`: the past reconciled onto the document that holds the
/// history. Everything is decided before anything is told or kept, so a
/// restore this crate leaves pending has done nothing; then a page is told
/// it began, the write is kept, the observer told, the page told it ended,
/// and the point the restore made is recorded, best effort.
async fn in_place<P: Ports>(
    ports: &P,
    bytes: &[u8],
    record: &WorkspaceRecord,
    past: Past<'_>,
    path: &str,
) -> Result<Option<String>, Stop> {
    let notifier = ports.notifier();
    if let Some(refusal) = judged(&past.doc, path, kind_at(record, path).as_deref())? {
        return Err(refused_between(notifier, &past, path, refusal));
    }
    // The path is the one the document resolved to in this record, so a
    // document is there; the TypeScript answers a vanished one as not found.
    let (document, version) = (past.document_id, past.version_id);
    let gone = || refused_between(notifier, &past, path, not_found(document, version));
    let placed = record.placed_document_at(path).ok_or_else(gone)?;
    let document_id = placed.meta.document_id;
    let peer = ports.mint().peer_id();
    let written =
        write::past_at_node(bytes, peer, &document_id, &past.bytes, ports.clock().now_ms())?;
    notify(notifier, &past, path, RestorePhase::Started);
    {
        // Ended on every exit after the start — a kept write, a keeper's
        // refusal, or the call dropped at an await when the client cancels.
        let _ended = Ended { notifier, workspace_id: past.workspace_id, path };
        if let Some(update) = &written.update {
            ports.records().append(past.workspace_id, update).await.map_err(|e| Stop::from(&e))?;
        }
        if written.changed {
            let told = DocumentWritten {
                workspace_id: past.workspace_id.to_owned(),
                document_id: document_id.clone(),
                path: path.to_owned(),
            };
            ports.observer().document_written(&told).await;
        }
    }
    if written.changed {
        let point =
            NewVersion { label: None, auto: true, restored_from: Some(past.version_id.to_owned()) };
        // The content is kept by now: a keeper refusing the point (its
        // restore-point ceiling) costs the history a point, never the restore.
        let _ = ports.versions().save(past.workspace_id, &document_id, &point).await;
    }
    Ok(past.label)
}

#[cfg(test)]
mod tests;

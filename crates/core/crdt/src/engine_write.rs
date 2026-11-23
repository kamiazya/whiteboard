//! The document engine's `write`: a batch of named writers applied to a
//! document opened from bytes under a peer, answered as
//! `contracts/crdt/document-engine.schema.json` answers it — the update the
//! batch produced and the documents it touched, or the class a writer threw,
//! with the document left as it was.
//!
//! Each writer is looked up by name in [`apply`], so the writers still to be
//! ported join there; until then a batch naming one is not answered. A
//! writer whose rules live in a crate above this one (the workspace record's)
//! is answered through [`MoreWriters`], which also answers which documents
//! the batch touched.
//!
//! What is not answered here, so the caller answers it:
//! - a batch judged by the text limits (`judge: "text"`, the default). The
//!   TypeScript judges the update a write produced as a peer importing it
//!   would (`importWithinTextLimits`), which this crate does not port; a write
//!   the judge passes answers exactly what an unjudged one does, so a caller
//!   holding a judge of its own asks with `WriteJudge::None`.
//! - a writer naming `documentId`, a document hosted on a workspace tree node,
//!   whose `changed` is the record's `documentsTouchedSince`.
//! - an argument the writer's TypeScript types refuse ([`Fault::Declined`]).
//!
//! A document that is the root of its own `LoroDoc` holds no workspace tree
//! the canvas writers write under, so the documents a write touched are none.

use crate::annotation_write::apply_annotation;
use crate::content_sync::reconcile_doc_content;
use crate::content_write::apply_content;
use crate::proposal_write::apply_proposal;
use crate::spatial_batch::{reconcile, with_spatial_batch};
use crate::spatial_write::{
    EDGE_LOCKS, EDGE_PLANE, Fault, NODE_LOCKS, NODE_PLANE, Step, delete_element, delete_node,
    field, items, set_lock, text, write_canvas, write_element,
};
use loro::{ExportMode, LoroDoc, VersionVector};
use whiteboard_model::Value;
use whiteboard_model::crdt::{MutationApplied, Write, WriteJudge, WriterName};
use whiteboard_model::encoding::bytes_to_base64;

/// The writers [`write_batch`] answers.
pub const ENGINE_WRITERS: &[WriterName] = &[
    WriterName::WriteSpatialCanvas,
    WriterName::WriteSpatialNode,
    WriterName::WriteSpatialEdge,
    WriterName::DeleteSpatialNode,
    WriterName::DeleteSpatialEdge,
    WriterName::ReconcileSpatialCanvas,
    WriterName::SetNodeLock,
    WriterName::SetEdgeLock,
    WriterName::WithSpatialBatch,
    WriterName::WriteMarkdownBody,
    WriterName::SpliceText,
    WriterName::WriteDocumentKind,
    WriterName::WriteFacets,
    WriterName::WriteCoreFacets,
    WriterName::WriteTrustFacets,
    WriterName::ReconcileFacets,
    WriterName::ReconcileCoreFacets,
    WriterName::WriteCanvasFacetsField,
    WriterName::WriteCommentThread,
    WriterName::WriteThreadMessage,
    WriterName::SetCommentThreadStatus,
    WriterName::MoveCommentThread,
    WriterName::MarkThreadPassages,
    WriterName::WriteProposal,
    WriterName::SetProposedChangeStatus,
    WriterName::WithDocumentBatch,
    WriterName::ReconcileDocContent,
];

/// What a batch answered.
#[derive(Debug, Clone, PartialEq)]
pub enum WriteAnswer {
    /// `{ outcome: "applied", ... }`.
    Applied(MutationApplied),
    /// A writer threw this class; nothing of the batch was kept.
    Thrown(&'static str),
}

/// A batch's answer and the document after it.
#[derive(Debug)]
pub struct Written {
    pub answer: WriteAnswer,
    pub doc: LoroDoc,
}

/// A JSON number written past 2^53 is the double `JSON.parse` reads it as.
fn as_parsed(value: &Value) -> Result<Value, Fault> {
    Ok(match value {
        Value::BigInt(digits) => Value::Number(digits.parse().map_err(|_| Fault::Declined)?),
        Value::Seq(items) => Value::Seq(items.iter().map(as_parsed).collect::<Result<_, _>>()?),
        Value::Map(entries) => Value::Map(
            entries
                .iter()
                .map(|(k, v)| Ok((k.clone(), as_parsed(v)?)))
                .collect::<Result<_, Fault>>()?,
        ),
        other => other.clone(),
    })
}

/// A writer with a single argument, the `id` its write names.
fn id_writer(doc: &LoroDoc, args: &Value, write: impl Fn(&LoroDoc, &str) -> Step) -> Step {
    write(doc, text(field(args, "id"))?)
}

/// One writer by name. Each commits where its TypeScript commits.
fn apply(doc: &LoroDoc, op: WriterName, args: &Value) -> Step {
    let arg = |key: &str| field(args, key).ok_or(Fault::Declined);
    match op {
        WriterName::WriteSpatialCanvas => write_canvas(doc, arg("canvas")?),
        WriterName::WriteSpatialNode => {
            write_element(doc, NODE_PLANE, arg("node")?)?;
            doc.commit();
            Ok(())
        }
        WriterName::WriteSpatialEdge => {
            write_element(doc, EDGE_PLANE, arg("edge")?)?;
            doc.commit();
            Ok(())
        }
        WriterName::DeleteSpatialNode => id_writer(doc, args, delete_node),
        WriterName::DeleteSpatialEdge => id_writer(doc, args, |doc, id| {
            if delete_element(doc, EDGE_PLANE, id)? {
                doc.commit();
            }
            Ok(())
        }),
        WriterName::ReconcileSpatialCanvas => reconcile(doc, arg("prev")?, arg("next")?),
        WriterName::SetNodeLock => {
            id_writer(doc, args, |doc, id| set_lock(doc, NODE_LOCKS, id, field(args, "locked")))
        }
        WriterName::SetEdgeLock => {
            id_writer(doc, args, |doc, id| set_lock(doc, EDGE_LOCKS, id, field(args, "locked")))
        }
        WriterName::WithSpatialBatch => with_spatial_batch(doc, items(field(args, "steps"))?),
        WriterName::ReconcileDocContent => reconcile_doc_content(doc, text(field(args, "past"))?),
        _ => apply_content(doc, op, args)
            .or_else(|| apply_annotation(doc, op, args))
            .or_else(|| apply_proposal(doc, op, args))
            .unwrap_or(Err(Fault::Declined)),
    }
}

/// Writers a crate above this one answers in the same batch, beside the ones
/// [`ENGINE_WRITERS`] lists.
pub trait MoreWriters {
    /// The writer applied, or `None` for one this does not answer.
    fn apply(&self, doc: &LoroDoc, op: WriterName, args: &Value) -> Option<Step>;
    /// The documents the operations after `from` wrote to, for a batch that
    /// wrote any.
    fn changed(&self, doc: &LoroDoc, from: &VersionVector) -> Vec<String>;
}

/// A writer this crate answers: one it ports, over a document of its own.
fn answerable(write: &Write) -> bool {
    ENGINE_WRITERS.contains(&write.op) && field(&write.args, "documentId").is_none()
}

/// The batch applied to the document `before` holds, written as `peer`: the
/// update it produced and the document after it, or the class a writer threw
/// and the document as it was. `None` for what this crate does not answer
/// (see the module's header).
#[must_use]
pub fn write_batch(
    before: &[u8],
    peer: u64,
    batch: &[Write],
    judge: WriteJudge,
) -> Option<Written> {
    run(before, peer, batch, judge, None)
}

/// [`write_batch`], with the writers `more` answers beside this crate's.
#[must_use]
pub fn write_batch_with(
    before: &[u8],
    peer: u64,
    batch: &[Write],
    judge: WriteJudge,
    more: &dyn MoreWriters,
) -> Option<Written> {
    run(before, peer, batch, judge, Some(more))
}

/// The batch, with no writer beyond this crate's when `more` is `None`: a
/// document that is the root of its own `LoroDoc` holds no workspace tree, so
/// a write there touches no document.
fn run(
    before: &[u8],
    peer: u64,
    batch: &[Write],
    judge: WriteJudge,
    more: Option<&dyn MoreWriters>,
) -> Option<Written> {
    if judge != WriteJudge::None || !batch.iter().all(|write| matches!(write.args, Value::Map(_))) {
        return None;
    }
    let doc = crate::import_bytes(before).ok()?;
    doc.set_peer_id(peer).ok()?;
    let from = doc.oplog_vv();
    for write in batch {
        let args = as_parsed(&write.args).ok()?;
        let step = if answerable(write) {
            apply(&doc, write.op, &args)
        } else {
            more?.apply(&doc, write.op, &args)?
        };
        match step {
            Ok(()) => {}
            Err(Fault::Thrown(class)) => {
                let doc = crate::import_bytes(before).ok()?;
                return Some(Written { answer: WriteAnswer::Thrown(class), doc });
            }
            Err(Fault::Declined) => return None,
        }
    }
    doc.commit();
    let mut applied = MutationApplied::default();
    if doc.oplog_vv() != from {
        let update = doc.export(ExportMode::updates(&from)).ok()?;
        applied.local_update = Some(bytes_to_base64(&update));
        applied.changed = more.map(|more| more.changed(&doc, &from)).unwrap_or_default();
    }
    Some(Written { answer: WriteAnswer::Applied(applied), doc })
}

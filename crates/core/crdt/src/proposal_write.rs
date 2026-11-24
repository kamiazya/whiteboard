//! The proposal layer's writers and `withDocumentBatch` over a document that
//! is the root of its own `LoroDoc`, as `proposals.ts` and `document-batch.ts`
//! write them: one loro call for one npm loro-crdt call, in the same order.
//!
//! A change is a plain value under its own id, so stamping a verdict rewrites
//! the change whole: its stored value as npm loro-crdt hands it to JavaScript,
//! keys in the order the map value iterates them, spread with the status.

use crate::annotation_write::{open_mergeable_map, put};
use crate::annotations::child_map;
use crate::content_write::splice_minimal;
use crate::host::Host;
use crate::spatial_batch::reconcile_into;
use crate::spatial_write::{Fault, Step, field, items, text};
use loro::{LoroValue, ValueOrContainer};
use whiteboard_model::crdt::WriterName;
use whiteboard_model::{Value, enumeration_order};

const PROPOSALS: &str = "proposals";
const CHANGES: &str = "changes";
const STATUS: &str = "status";
const BODY: &str = "body";

/// A loro value as npm loro-crdt hands it to JavaScript: an integer as the
/// number it rounds to, an object's keys in the map value's own order. `None`
/// for bytes, which reach JavaScript as a typed array this crate does not
/// spread.
pub(crate) fn as_js(value: &LoroValue) -> Option<Value> {
    Some(match value {
        LoroValue::Null => Value::Null,
        LoroValue::Bool(b) => Value::Bool(*b),
        LoroValue::Double(d) => Value::Number(*d),
        LoroValue::I64(_) => crate::read::loro_value_to_value(value),
        LoroValue::String(s) => Value::String(s.to_string()),
        LoroValue::List(items) => Value::Seq(items.iter().map(as_js).collect::<Option<_>>()?),
        LoroValue::Map(entries) => Value::Map(
            entries.iter().map(|(k, v)| Some((k.clone(), as_js(v)?))).collect::<Option<_>>()?,
        ),
        LoroValue::Binary(_) | LoroValue::Container(_) => return None,
    })
}

/// `writeProposal`: the proposal's own fields and every change, a change
/// spread into a plain value, in one commit.
fn write_proposal(host: &Host<'_>, proposal: &Value) -> Step {
    let id = text(field(proposal, "id"))?;
    let changes = items(field(proposal, "changes"))?;
    let changes = changes
        .iter()
        .map(|change| match change {
            Value::Map(_) => text(field(change, "id")).map(|id| (id, change)),
            _ => Err(Fault::Declined),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let container = open_mergeable_map(&host.map(PROPOSALS)?, id)?;
    for key in ["author", "createdAt"] {
        if let Some(held) = field(proposal, key) {
            put(&container, key, held)?;
        }
    }
    let held = open_mergeable_map(&container, CHANGES)?;
    for (change_id, change) in changes {
        put(&held, change_id, change)?;
    }
    host.commit();
    Ok(())
}

/// `setProposedChangeStatusInto`: the change rewritten with the status, and
/// nothing for a proposal, a change map or a change that is not held, or a
/// change that is a scalar. The plane is peeked, so a verdict opens nothing.
fn set_status_into(host: &Host<'_>, args: &Value) -> Step {
    let proposal_id = text(field(args, "proposalId"))?;
    let change_id = text(field(args, "changeId"))?;
    let status = field(args, STATUS).ok_or(Fault::Declined)?;
    let Some(plane) = host.peek_map(PROPOSALS)? else { return Ok(()) };
    let Some(container) = child_map(plane.get(proposal_id)) else { return Ok(()) };
    let Some(changes) = child_map(container.get(CHANGES)) else { return Ok(()) };
    let stored = match changes.get(change_id) {
        Some(ValueOrContainer::Value(LoroValue::Map(stored))) => stored,
        // JavaScript spreads an array or a typed array by index.
        Some(
            ValueOrContainer::Value(LoroValue::List(_) | LoroValue::Binary(_))
            | ValueOrContainer::Container(_),
        ) => return Err(Fault::Declined),
        None | Some(ValueOrContainer::Value(_)) => return Ok(()),
    };
    let Some(Value::Map(mut entries)) = as_js(&LoroValue::Map(stored)).map(enumeration_order)
    else {
        return Err(Fault::Declined);
    };
    match entries.iter_mut().find(|(key, _)| key == STATUS) {
        Some(entry) => entry.1 = status.clone(),
        None => entries.push((STATUS.to_owned(), status.clone())),
    }
    put(&changes, change_id, &Value::Map(entries))
}

/// `withDocumentBatch` over the engine's steps: a body write, a canvas
/// reconcile, and any other op read as a verdict, as the TypeScript's dispatch
/// reads it, in one commit. The TypeScript commits only when a step wrote;
/// a commit with nothing pending is no operation in loro, so this one need
/// not ask.
fn with_document_batch(host: &Host<'_>, steps: &[Value]) -> Step {
    for step in steps {
        if !matches!(step, Value::Map(_)) {
            return Err(Fault::Declined);
        }
        match field(step, "op") {
            Some(Value::String(op)) if op == "writeMarkdownBody" => {
                splice_minimal(&host.text(BODY)?, text(field(step, "body"))?)?;
            }
            Some(Value::String(op)) if op == "reconcileSpatialCanvas" => {
                let side = |key: &str| field(step, key).ok_or(Fault::Declined);
                reconcile_into(host, side("prev")?, side("next")?)?;
            }
            _ => set_status_into(host, step)?,
        }
    }
    host.commit();
    Ok(())
}

/// One proposal writer by name; `None` for a writer that is not one.
pub(crate) fn apply_proposal(host: &Host<'_>, op: WriterName, args: &Value) -> Option<Step> {
    Some(match op {
        WriterName::WriteProposal => {
            field(args, "proposal").ok_or(Fault::Declined).and_then(|p| write_proposal(host, p))
        }
        WriterName::SetProposedChangeStatus => set_status_into(host, args).map(|()| host.commit()),
        WriterName::WithDocumentBatch => {
            items(field(args, "steps")).and_then(|steps| with_document_batch(host, steps))
        }
        _ => return None,
    })
}

//! A spatial document read as JSON Canvas (server-core's `exportJsonCanvas`):
//! the canvas the engine stores, lifted into the model's canvas and written by
//! the codec, strictly (JSON Canvas 1.0 alone, re-validated) or extended.
//!
//! The TypeScript hands the canvas to the same codec across the wasm wire, so
//! what it declines there is declined here too, before writing: a wire past
//! the entry's cap or the shim's depth ([`wire`]), a value the wire does not
//! read back as a canvas, and whatever the codec itself declines. Those are
//! refused in the shim's words, so pending. A canvas the strict mode refuses
//! is the one document's failure, in the words of the `ZodError` the shim
//! throws ([`refusal`]).

mod refusal;
mod wire;

use whiteboard_codec::json_canvas::{Mode, WriteFailure, serialize};
use whiteboard_model::Value;
use whiteboard_model::canvas_value::canvas_of;
use whiteboard_model::crdt::QueryName;

use super::engine::{Fault, Hosted};
use super::{Pending, Stop};

/// The document as JSON Canvas text, or the reason the strict mode refused it.
pub(super) fn export(hosted: Hosted<'_>, strict: bool) -> Result<Result<String, String>, Fault> {
    let stored = canvas_in(hosted.read(QueryName::SpatialCanvas, &[])?);
    written(hosted.document_id, &stored, strict)
        .map_err(|pending| Fault::Stop(Stop::Pending(pending)))
}

/// The JSON Canvas text of the canvas `stored`, the reason the strict mode
/// refused it, or the writer's decline.
fn written(id: &str, stored: &Value, strict: bool) -> Result<Result<String, String>, Pending> {
    let declined = || Pending::JsonCanvasDeclined(id.to_owned());
    if !wire::carried(stored) {
        return Err(declined());
    }
    let canvas = canvas_of(stored).ok_or_else(declined)?;
    let mode = if strict { Mode::Strict } else { Mode::Extended };
    match serialize(&canvas, mode) {
        Ok(text) => Ok(Ok(text)),
        Err(WriteFailure::Schema(issues)) => {
            refusal::serialize_failed(id, &issues).map(Err).ok_or_else(declined)
        }
        Err(WriteFailure::Declined(_)) => Err(declined()),
    }
}

/// The canvas of the engine's `{ canvas, skipped }`. The count of the records
/// its schema skipped is a warning in the TypeScript's log, and no part of the
/// answer.
fn canvas_in(answer: Value) -> Value {
    let Value::Map(entries) = answer else { return Value::Null };
    entries.into_iter().find(|(key, _)| key == "canvas").map_or(Value::Null, |(_, canvas)| canvas)
}

#[cfg(test)]
mod tests;

//! The text-limit judge of a document's STATE: the verdict
//! `judgeStateWithinTextLimits` gives, as though the state were written into
//! an empty document — every bound judged against nothing before, and no
//! insert run judged, since loading into an empty document replays none.
//!
//! The verdict is read off the history that produced the state, as the
//! TypeScript reads it off an update: the places its ops wrote, judged on the
//! state they leave. The checks run in the TypeScript's order, so a state
//! past several bounds is named by the same one: what the history leaves
//! standing (a write into a container it never saw created, the reserved key,
//! a long container name, a content key holding the wrong thing), then the
//! body, the values, the board, the annotation counts, and the retired shapes.

mod breach;
mod counts;
mod place;
mod retired;
mod structure;
mod values;
mod writes;

pub use breach::{BreachShape, TextBreach};

use loro::{ExportMode, LoroDoc, VersionVector};

/// The judge could not read the state it was given: forking it, exporting it
/// or reading its history back failed. The TypeScript throws there too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unjudged;

/// The state `doc` shows, alone in a document of its own.
fn state_of(doc: &LoroDoc) -> Result<LoroDoc, Unjudged> {
    let at = doc.fork_at(&doc.state_frontiers()).map_err(|_| Unjudged)?;
    let bytes = at.export(ExportMode::Snapshot).map_err(|_| Unjudged)?;
    let state = LoroDoc::new();
    state.import(&bytes).map_err(|_| Unjudged)?;
    Ok(state)
}

/// The first limit the state `doc` shows breaks, or `None` when it may be
/// kept. `doc` is left as it was.
///
/// # Errors
///
/// [`Unjudged`] when the state cannot be copied or its history read.
pub fn judge_state(doc: &LoroDoc) -> Result<Option<TextBreach>, Unjudged> {
    let state = state_of(doc)?;
    let json = state
        .export_json_updates_without_peer_compression(&VersionVector::default(), &state.oplog_vv())
        .map_err(|_| Unjudged)?;
    if let Some(found) = structure::unattached_breach(&state, &json)
        .or_else(|| structure::reserved_key_breach(&json))
    {
        return Ok(Some(found));
    }
    let writes = writes::read_writes(&json);
    if let Some(found) = structure::long_name_breach(&state, &writes.names) {
        return Ok(Some(found));
    }
    Ok(structure::content_root_breach(&state, &writes.content_keys.entries)
        .or_else(|| counts::body_breach(&state, &writes.net.entries))
        .or_else(|| values::value_breach(&state, &writes.long_values))
        .or_else(|| counts::canvas_breach(&state, &writes.set_into.ids()))
        .or_else(|| counts::annotation_breach(&state, &writes.maps_written.ids()))
        .or_else(|| retired::retired_breach(&state, &writes.inserted)))
}

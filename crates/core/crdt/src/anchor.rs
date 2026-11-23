//! Where an annotation points, over the loro value a thread or a proposed
//! passage stores it as: the model's `annotationAnchorSchema` and
//! `textAnchorSchema`.
//!
//! Each check answers whether the TypeScript's schema accepts the value. Every
//! object is strict, so a value that passes is what the reader hands back and
//! is written as stored.

use crate::stored::{field, is_text, map_of, names_only, node_id, optional, required, text};
use loro::{LoroMapValue, LoroValue};
use std::collections::BTreeSet;

/// `CANVAS_MAX_NODES`: the most nodes one anchor names, a board's worth.
const ANCHOR_NODES_MAX: usize = 2000;
/// The largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// A value `z.number().int()` accepts: a safe integer.
fn integer(value: &LoroValue) -> bool {
    match value {
        LoroValue::Double(d) => {
            d.is_finite() && d.fract().abs() <= 0.0 && d.abs() <= 9.007_199_254_740_991e15
        }
        LoroValue::I64(n) => n.unsigned_abs() <= MAX_SAFE_INTEGER,
        _ => false,
    }
}

fn non_negative_integer(value: &LoroValue) -> bool {
    integer(value)
        && match value {
            LoroValue::Double(d) => *d >= 0.0,
            LoroValue::I64(n) => *n >= 0,
            _ => false,
        }
}

fn as_number(value: &LoroValue) -> Option<f64> {
    match value {
        LoroValue::Double(d) => Some(*d),
        #[expect(
            clippy::cast_precision_loss,
            reason = "npm loro-crdt hands every i64 to JavaScript as a number, so a comparison is made on the rounded one"
        )]
        LoroValue::I64(n) => Some(*n as f64),
        _ => None,
    }
}

fn node_set(value: &LoroValue) -> bool {
    let LoroValue::List(ids) = value else { return false };
    let named: BTreeSet<&str> = ids.iter().filter_map(text).collect();
    (2..=ANCHOR_NODES_MAX).contains(&ids.len())
        && ids.iter().all(node_id)
        && named.len() == ids.len()
}

fn spatial(anchor: &LoroMapValue) -> bool {
    let references = ["nodeId", "edgeId", "nodeIds"].iter().filter(|k| field(anchor, k).is_some());
    names_only(anchor, &["kind", "nodeId", "edgeId", "nodeIds", "x", "y", "width", "height"])
        && required(anchor, "x", integer)
        && required(anchor, "y", integer)
        && optional(anchor, "nodeId", node_id)
        && optional(anchor, "edgeId", node_id)
        && optional(anchor, "nodeIds", node_set)
        && optional(anchor, "width", non_negative_integer)
        && optional(anchor, "height", non_negative_integer)
        && references.count() <= 1
        && field(anchor, "width").is_some() == field(anchor, "height").is_some()
}

fn quote(value: &LoroValue) -> bool {
    map_of(value).is_some_and(|q| {
        names_only(q, &["prefix", "exact", "suffix"])
            && required(q, "exact", |v| text(v).is_some_and(|exact| !exact.is_empty()))
            && optional(q, "prefix", is_text)
            && optional(q, "suffix", is_text)
    })
}

fn passage(anchor: &LoroMapValue) -> bool {
    let offset = |key: &str| field(anchor, key).and_then(as_number);
    names_only(anchor, &["kind", "nodeId", "quote", "start", "end"])
        && required(anchor, "quote", quote)
        && optional(anchor, "nodeId", node_id)
        && required(anchor, "start", non_negative_integer)
        && required(anchor, "end", non_negative_integer)
        && offset("end") >= offset("start")
}

fn kind_of(anchor: &LoroMapValue) -> Option<&str> {
    field(anchor, "kind").and_then(text)
}

/// Whether `textAnchorSchema` accepts the value: a passage of prose.
pub(crate) fn text_anchor(value: &LoroValue) -> bool {
    map_of(value).is_some_and(|anchor| kind_of(anchor) == Some("text") && passage(anchor))
}

/// Whether `annotationAnchorSchema` accepts the value: a point or region of
/// the canvas, a passage, or the document as a whole.
pub(crate) fn annotation_anchor(value: &LoroValue) -> bool {
    let Some(anchor) = map_of(value) else { return false };
    match kind_of(anchor) {
        Some("spatial") => spatial(anchor),
        Some("text") => passage(anchor),
        Some("document") => names_only(anchor, &["kind"]),
        _ => false,
    }
}

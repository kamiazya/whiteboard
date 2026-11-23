//! Which uploaded pictures a document still names: what its canvas shows, what
//! its markdown body embeds, and what an open proposed change would draw once
//! adopted (`collectImageRefIds`). A picture is named `asset:<id>`, and the ids
//! are what a keeper decides a blob's fate from.
//!
//! The scan of a body is `storedImageRefs`'s: a hand scan for the first `](`
//! after each `![`, not a parse, so an alt text holding its own `]` reads as a
//! malformed image and is skipped.

use crate::annotations::by_code_unit;
use crate::canvas::read_canvas;
use crate::content::{Refusal, text_of};
use crate::proposals::read_proposals;
use crate::stored::{URI_LIST, field, map_of, text};
use loro::{LoroDoc, LoroMapValue, LoroValue};
use whiteboard_model::Value;
use whiteboard_model::node_content::is_image_ref;

/// `imageRefId`'s prefix, which `is_image_ref` tests.
const IMAGE_REF_PREFIX: &str = "asset:";

/// The first `needle` at or after `from`, as a byte offset.
fn find_from(body: &str, needle: &str, from: usize) -> Option<usize> {
    body.get(from..)?.find(needle).and_then(|found| found.checked_add(from))
}

/// The link destination starting at `open` and the offset just past it.
fn destination_at(body: &str, open: usize) -> Option<(&str, usize)> {
    if body.get(open..)?.starts_with('<') {
        let shut = find_from(body, ">", open.checked_add(1)?)?;
        return Some((body.get(open.checked_add(1)?..shut)?, shut.checked_add(1)?));
    }
    let tail = body.get(open..)?;
    let length = tail.find([')', '\t', '\n', '\r', ' ']).unwrap_or(tail.len());
    let end = open.checked_add(length)?;
    Some((body.get(open..end)?, end))
}

/// The stored pictures a markdown inline image names, as written.
fn inline_refs(body: &str) -> Vec<&str> {
    let mut refs = Vec::new();
    let mut at = 0_usize;
    while let Some(bang) = find_from(body, "![", at) {
        // A search never answers before where it began; one that does cannot advance the scan.
        if bang < at {
            break;
        }
        let Some(close) = bang.checked_add(2).and_then(|from| find_from(body, "](", from)) else {
            break;
        };
        let Some((url, end)) = close.checked_add(2).and_then(|open| destination_at(body, open))
        else {
            break;
        };
        if is_image_ref(url) {
            refs.push(url);
        }
        // Every destination ends past where the scan stood; the floor keeps a scan that cannot move from spinning.
        at = end.max(at.saturating_add(1));
    }
    refs
}

fn named<'a>(map: &'a LoroMapValue, key: &str) -> Option<&'a str> {
    field(map, key).and_then(text)
}

/// The pictures a stored node names: a file node's file, a text node's inline
/// images, a frame's background.
fn node_refs(node: &LoroValue) -> Vec<&str> {
    let Some(record) = map_of(node) else { return Vec::new() };
    let Some(resource) = field(record, "resource").and_then(map_of) else {
        return named(record, "background").filter(|b| is_image_ref(b)).into_iter().collect();
    };
    match (named(resource, "content"), named(resource, "location")) {
        (Some(content), _) => inline_refs(content),
        (None, Some(location)) if named(resource, "mimeType") != Some(URI_LIST) => {
            Some(location).filter(|l| is_image_ref(l)).into_iter().collect()
        }
        _ => Vec::new(),
    }
}

/// The pictures one open change would draw: a patch names a file or a
/// background by reference and text by what it embeds, whichever node it lands
/// on, and a replacement passage by what it embeds.
fn change_refs(change: &LoroValue) -> Vec<&str> {
    let Some(record) = map_of(change) else { return Vec::new() };
    match named(record, "op") {
        Some("node.add") => field(record, "node").map(node_refs).unwrap_or_default(),
        Some("node.patch") => {
            let Some(patch) = field(record, "patch").and_then(map_of) else { return Vec::new() };
            let by_reference = ["file", "background"].iter().filter_map(|k| named(patch, k));
            let embedded = named(patch, "text").map(inline_refs).unwrap_or_default();
            by_reference.filter(|r| is_image_ref(r)).chain(embedded).collect()
        }
        Some("body.replace") => named(record, "text").map(inline_refs).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// `imageRefIds`: the ids of every picture the document names, ascending
/// and without repeats. Refused as the canvas is, for a retired shape.
pub(crate) fn image_ref_ids(doc: &LoroDoc) -> Result<Value, Refusal> {
    let canvas = read_canvas(doc)?;
    let body = text_of(doc).to_string();
    let proposals = read_proposals(doc);
    let open = proposals
        .iter()
        .flat_map(|p| &p.changes)
        .filter(|change| map_of(change).and_then(|c| named(c, "status")) == Some("open"));
    let mut ids: Vec<&str> = inline_refs(&body)
        .into_iter()
        .chain(canvas.nodes().iter().flat_map(node_refs))
        .chain(open.flat_map(change_refs))
        .filter_map(|reference| reference.strip_prefix(IMAGE_REF_PREFIX))
        .collect();
    ids.sort_by(|a, b| by_code_unit(a, b));
    ids.dedup();
    Ok(Value::Seq(ids.into_iter().map(|id| Value::String(id.to_owned())).collect()))
}

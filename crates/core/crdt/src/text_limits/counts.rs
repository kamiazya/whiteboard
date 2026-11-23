//! The bounds on how much a document holds, judged on the state its history
//! leaves (`sync-text-limits.ts`'s body and board, `sync-annotation-limits.ts`):
//! a markdown body's length, a board's nodes and its edges and lines, a
//! document's open threads and open proposed changes, and one thread's
//! messages. A state is judged against nothing before it, so a count past its
//! bound is a breach whatever it was.

use super::breach::{BreachShape, TextBreach, count, text};
use super::place::{Place, child_map, has_root, map_at, place_of, value_at};
use loro::{Container, ContainerID, LoroDoc, LoroMap, LoroValue};
use std::collections::BTreeSet;

const MARKDOWN_MAX_CHARS: usize = 262_144;
const CANVAS_MAX_NODES: usize = 2000;
const CANVAS_MAX_EDGES_AND_LINES: usize = 2000;
const DOCUMENT_MAX_OPEN_THREADS: usize = 500;
const DOCUMENT_MAX_OPEN_CHANGES: usize = 1000;
const THREAD_MAX_MESSAGES: usize = 1000;

/// A body the history grew that the state leaves past its bound.
pub(super) fn body_breach(doc: &LoroDoc, net: &[(ContainerID, i64)]) -> Option<TextBreach> {
    net.iter().filter(|(_, grew)| *grew > 0).find_map(|(container, _)| {
        if !place_of(doc, container)?.is_content_at("body") {
            return None;
        }
        let Container::Text(body) = doc.get_container(container.clone())? else { return None };
        let length = body.len_utf16();
        (length > MARKDOWN_MAX_CHARS).then(|| {
            TextBreach::new(
                BreachShape::Body,
                vec![("chars", count(length)), ("container", text(&container.to_string()))],
            )
        })
    })
}

/// Each per-canvas bound: the maps it counts together, what it is called, its ceiling.
const CANVAS_BOUNDS: [(&[&str], &str, usize); 2] = [
    (&["nodes"], "nodes", CANVAS_MAX_NODES),
    (&["edges", "lines"], "edges-and-lines", CANVAS_MAX_EDGES_AND_LINES),
];

/// How many entries the board holding the map at `place` has across `keys`:
/// its siblings under the same tree node, or the roots the state lists.
fn board_size(doc: &LoroDoc, place: &Place, keys: &[&str]) -> usize {
    let parent = if place.len() > 1 { place.id(1).and_then(|id| map_at(doc, id)) } else { None };
    keys.iter()
        .map(|key| match &parent {
            Some(node) => child_map(node, key).map_or(0, |map| map.len()),
            None if place.len() == 1 && has_root(doc, key) => doc.get_map(*key).len(),
            None => 0,
        })
        .fold(0, usize::saturating_add)
}

/// A board some op set a key in that the state leaves past a per-canvas bound.
pub(super) fn canvas_breach(doc: &LoroDoc, set_into: &[ContainerID]) -> Option<TextBreach> {
    set_into.iter().find_map(|container| {
        let place = place_of(doc, container)?;
        let (keys, measure, max) = CANVAS_BOUNDS
            .into_iter()
            .find(|(keys, _, _)| keys.iter().any(|key| place.is_content_at(key)))?;
        let held = board_size(doc, &place, keys);
        (held > max).then(|| {
            TextBreach::new(
                BreachShape::CanvasSize,
                vec![
                    ("measure", text(measure)),
                    ("count", count(held)),
                    ("container", text(&container.to_string())),
                ],
            )
        })
    })
}

/// An annotation bound: what it is called, the map it counts at, its ceiling.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Annotation {
    OpenThreads,
    OpenChanges,
    ThreadMessages,
}

impl Annotation {
    const fn shape(self) -> BreachShape {
        match self {
            Self::OpenThreads => BreachShape::OpenThreads,
            Self::OpenChanges => BreachShape::OpenChanges,
            Self::ThreadMessages => BreachShape::ThreadMessages,
        }
    }

    const fn max(self) -> usize {
        match self {
            Self::OpenThreads => DOCUMENT_MAX_OPEN_THREADS,
            Self::OpenChanges => DOCUMENT_MAX_OPEN_CHANGES,
            Self::ThreadMessages => THREAD_MAX_MESSAGES,
        }
    }

    /// Whether a write to the map at `relative` below its document can move
    /// this bound: a document bound's map or those under it as deep as an
    /// annotation opens, the thread bound a thread's messages map alone.
    fn reaches(self, relative: &[&str]) -> bool {
        let root = relative.first().copied();
        match self {
            Self::OpenThreads => root == Some("threads") && relative.len() <= 2,
            Self::OpenChanges => root == Some("proposals") && relative.len() <= 3,
            Self::ThreadMessages => {
                root == Some("threads")
                    && relative.len() == 3
                    && relative.get(2) == Some(&"messages")
            }
        }
    }
}

fn status_open(value: Option<LoroValue>) -> bool {
    matches!(value, Some(LoroValue::String(status)) if status.as_str() == "open")
}

/// The threads in `threads` whose status is open.
fn open_threads(threads: &LoroMap) -> usize {
    threads
        .keys()
        .filter(|id| child_map(threads, id).is_some_and(|t| status_open(value_at(&t, "status"))))
        .count()
}

/// The proposed changes under `proposals` whose status is open.
fn open_changes(proposals: &LoroMap) -> usize {
    let open_in = |changes: LoroMap| {
        changes
            .keys()
            .filter(|id| match value_at(&changes, id) {
                Some(LoroValue::Map(change)) => status_open(change.get("status").cloned()),
                _ => false,
            })
            .count()
    };
    proposals
        .keys()
        .filter_map(|id| child_map(&child_map(proposals, &id)?, "changes"))
        .map(open_in)
        .fold(0, usize::saturating_add)
}

/// The annotation bound a write to the map `container` moves, the document
/// (or thread) it counts toward as one key, and the map counted there.
fn reached(doc: &LoroDoc, container: &ContainerID) -> Option<(Annotation, String, ContainerID)> {
    let place = place_of(doc, container)?;
    let relative = place.relative();
    let bound = [Annotation::OpenThreads, Annotation::OpenChanges, Annotation::ThreadMessages]
        .into_iter()
        .find(|bound| bound.reaches(&relative))?;
    let prefix = place.document_prefix();
    if bound == Annotation::ThreadMessages {
        let thread = relative.get(1).copied().unwrap_or_default();
        return Some((bound, format!("{prefix} thread-messages {thread}"), container.clone()));
    }
    let level = place.document_level()?.clone();
    Some((bound, format!("{prefix} {}", bound.shape().wire()), level))
}

/// How many `bound` counts open at the map `counted`.
fn open_at(doc: &LoroDoc, bound: Annotation, counted: &ContainerID) -> usize {
    map_at(doc, counted).map_or(0, |map| match bound {
        Annotation::OpenThreads => open_threads(&map),
        Annotation::OpenChanges => open_changes(&map),
        Annotation::ThreadMessages => map.len(),
    })
}

/// A document, or a thread, the state leaves holding more than its bound,
/// counted once per owner — counting walks every thread or change a document
/// holds — in the order the history first wrote to it.
pub(super) fn annotation_breach(doc: &LoroDoc, written: &[ContainerID]) -> Option<TextBreach> {
    let mut owners = BTreeSet::new();
    written.iter().find_map(|container| {
        let (bound, owner, counted) = reached(doc, container)?;
        if !owners.insert(owner) {
            return None;
        }
        let open = open_at(doc, bound, &counted);
        (open > bound.max()).then(|| {
            TextBreach::new(
                bound.shape(),
                vec![("count", count(open)), ("container", text(&counted.to_string()))],
            )
        })
    })
}

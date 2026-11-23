//! The spatial canvas's writers over a document that is the root of its own
//! `LoroDoc`, as the TypeScript's `loro-bridge.ts` writes it: one loro call for
//! one npm loro-crdt call, in the same order, so the operations a write appends
//! are the TypeScript's own and so are the bytes of its update.
//!
//! The arguments are the writer's JSON as the engine is handed it. One the
//! TypeScript's own types refuse (an id that is not a string, a collection
//! that is not an array) is [`Fault::Declined`]: JavaScript coerces it in ways
//! nobody relies on, and the caller answers it instead. What the TypeScript
//! refuses on purpose is [`Fault::Thrown`] with the class it throws.

use crate::content::{first_retired, retired_edge_shape, value_of};
use crate::read::loro_value_to_value;
use crate::stored;
use crate::write::plain;
use loro::{LoroDoc, LoroValue, ValueOrContainer};
use std::collections::BTreeSet;
use whiteboard_model::{Value, enumeration_order};

pub(crate) const NODES: &str = "nodes";
pub(crate) const EDGES: &str = "edges";
pub(crate) const LINES: &str = "lines";
pub(crate) const CANVAS: &str = "canvas";
pub(crate) const NODE_LOCKS: &str = "nodeLocks";
pub(crate) const EDGE_LOCKS: &str = "edgeLocks";
const FACETS_FIELD: &str = "facets";
const TAGS_FIELD: &str = "tags";
const RESERVED_MAP_KEY: &str = "__proto__";

/// Why a writer did not apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// The TypeScript throws this class: the document is left as it was.
    Thrown(&'static str),
    /// An argument the TypeScript's types refuse: not answered here.
    Declined,
}

/// What one writer answered.
pub type Step = Result<(), Fault>;

const TYPE_ERROR: Fault = Fault::Thrown("TypeError");
const RESERVED_KEY: Fault = Fault::Thrown("ReservedKeyWriteError");
const RETIRED_SHAPE: Fault = Fault::Thrown("RetiredStoredShapeError");

/// The entry of an object argument at `key`; `None` for an absent key and for
/// a value that is not an object.
pub(crate) fn field<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    match value {
        Value::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

/// The string an argument must be, declined otherwise.
pub(crate) fn text(value: Option<&Value>) -> Result<&str, Fault> {
    match value {
        Some(Value::String(s)) => Ok(s),
        _ => Err(Fault::Declined),
    }
}

/// The array an argument must be, declined otherwise.
pub(crate) fn items(value: Option<&Value>) -> Result<&[Value], Fault> {
    match value {
        Some(Value::Seq(items)) => Ok(items),
        _ => Err(Fault::Declined),
    }
}

/// `holdsReservedKey`: a key named `__proto__` anywhere in the value.
pub(crate) fn holds_reserved_key(value: &Value) -> bool {
    match value {
        Value::Map(entries) => {
            entries.iter().any(|(k, v)| k == RESERVED_MAP_KEY || holds_reserved_key(v))
        }
        Value::Seq(items) => items.iter().any(holds_reserved_key),
        _ => false,
    }
}

/// `refuseReservedKey`, asked before the first op of the write it guards.
pub(crate) fn refuse_reserved_key(value: &Value) -> Step {
    if holds_reserved_key(value) { Err(RESERVED_KEY) } else { Ok(()) }
}

pub(crate) fn set(doc: &LoroDoc, map: &str, key: &str, value: &Value) -> Step {
    let value = plain(value).map_err(|_| Fault::Declined)?;
    doc.get_map(map).insert(key, value).map_err(|_| Fault::Declined)
}

pub(crate) fn delete(doc: &LoroDoc, map: &str, key: &str) -> Step {
    doc.get_map(map).delete(key).map_err(|_| Fault::Declined)
}

/// Whether `map` holds anything at `key`: `get(key) !== undefined`.
pub(crate) fn holds(doc: &LoroDoc, map: &str, key: &str) -> bool {
    doc.get_map(map).get(key).is_some()
}

/// `dropLockInto`: a removed element's lock goes with it.
fn drop_lock(doc: &LoroDoc, locks: &str, id: &str) -> Step {
    if holds(doc, locks, id) { delete(doc, locks, id) } else { Ok(()) }
}

/// The fields every element starts with, in the order the TypeScript writes
/// them, then each of `optional` the element holds.
fn project(element: &Value, leading: Vec<(String, Value)>, optional: &[&str]) -> Value {
    let mut fields = leading;
    for key in optional {
        if let Some(held) = field(element, key) {
            fields.push(((*key).to_owned(), held.clone()));
        }
    }
    Value::Map(fields)
}

/// `nodeToFields`: geometry that is not a finite number is refused loudly,
/// since a reader would drop the node for every peer.
fn node_fields(node: &Value) -> Result<Value, Fault> {
    let mut leading = vec![("id".to_owned(), Value::String(text(field(node, "id"))?.to_owned()))];
    for key in ["x", "y", "width", "height"] {
        match field(node, key) {
            Some(Value::Number(n)) if n.is_finite() => {
                leading.push((key.to_owned(), Value::Number(*n)));
            }
            _ => return Err(TYPE_ERROR),
        }
    }
    let optional =
        ["color", "embed", "facets", "tags", "resource", "label", "background", "backgroundStyle"];
    Ok(project(node, leading, &optional))
}

/// `edgeToFields` and `lineToFields`: an id and both ends, then what is held.
fn element_fields(element: &Value, optional: &[&str]) -> Result<Value, Fault> {
    let mut leading =
        vec![("id".to_owned(), Value::String(text(field(element, "id"))?.to_owned()))];
    for key in ["from", "to"] {
        leading.push((key.to_owned(), field(element, key).ok_or(Fault::Declined)?.clone()));
    }
    Ok(project(element, leading, optional))
}

fn edge_fields(edge: &Value) -> Result<Value, Fault> {
    element_fields(edge, &["color", "label", "bends", "facets", "tags"])
}

fn line_fields(line: &Value) -> Result<Value, Fault> {
    element_fields(line, &["color", "label", "bends", "facets"])
}

/// One collection of the canvas: its map, the lock plane its removals clear,
/// and how one of its elements is written.
#[derive(Clone, Copy)]
pub(crate) struct Plane {
    map: &'static str,
    locks: &'static str,
    fields: fn(&Value) -> Result<Value, Fault>,
}

impl Plane {
    /// Whether this is the node collection, whose removal sweeps.
    pub(crate) fn is_nodes(self) -> bool {
        self.map == NODES
    }
}

pub(crate) const NODE_PLANE: Plane = Plane { map: NODES, locks: NODE_LOCKS, fields: node_fields };
pub(crate) const EDGE_PLANE: Plane = Plane { map: EDGES, locks: EDGE_LOCKS, fields: edge_fields };
/// Lines share the edge lock plane: ids are unique across both collections.
pub(crate) const LINE_PLANE: Plane = Plane { map: LINES, locks: EDGE_LOCKS, fields: line_fields };

/// `writeNodeInto` and its edge and line counterparts.
pub(crate) fn write_element(doc: &LoroDoc, plane: Plane, element: &Value) -> Step {
    refuse_reserved_key(element)?;
    let id = text(field(element, "id"))?;
    set(doc, plane.map, id, &(plane.fields)(element)?)
}

/// `deleteEdgeInto` and the like: the element and its lock, `false` (writing
/// nothing) when the id is absent.
pub(crate) fn delete_element(doc: &LoroDoc, plane: Plane, id: &str) -> Result<bool, Fault> {
    if !holds(doc, plane.map, id) {
        return Ok(false);
    }
    delete(doc, plane.map, id)?;
    drop_lock(doc, plane.locks, id)?;
    Ok(true)
}

/// `refuseRetiredEdgesBeforeRemoval`: an edge the sweep cannot parse would
/// outlive the node it is anchored on.
pub(crate) fn refuse_retired_edges(doc: &LoroDoc) -> Step {
    match first_retired(&doc.get_map(EDGES), retired_edge_shape) {
        Some(_) => Err(RETIRED_SHAPE),
        None => Ok(()),
    }
}

/// The node an end of a record its schema accepted sits on (`endNode`). The
/// schema admits `node` on an edge's end and a line's node arm alone, and
/// refuses a point end or an unknown kind that carries one, so an accepted
/// end names a node exactly when it holds the key.
fn end_node(end: Option<&LoroValue>) -> Option<&str> {
    let LoroValue::Map(end) = end? else { return None };
    match end.get("node")? {
        LoroValue::String(id) => Some(id.as_str()),
        _ => None,
    }
}

/// `anchoredOnAny`, over a record its schema accepted.
fn anchored(record: &LoroValue, ids: &BTreeSet<String>) -> bool {
    let LoroValue::Map(fields) = record else { return false };
    [fields.get("from"), fields.get("to")]
        .into_iter()
        .any(|end| end_node(end).is_some_and(|node| ids.contains(node)))
}

fn sweep_plane(
    doc: &LoroDoc,
    plane: Plane,
    accepts: fn(&LoroValue) -> bool,
    ids: &BTreeSet<String>,
) -> Step {
    let map = doc.get_map(plane.map);
    for id in map.keys() {
        let held = map.get(&id).and_then(value_of);
        if held.is_some_and(|record| accepts(&record) && anchored(&record, ids)) {
            delete(doc, plane.map, &id)?;
            drop_lock(doc, plane.locks, &id)?;
        }
    }
    Ok(())
}

/// `sweepAnchoredInto`: every edge and line with an end on a removed node,
/// with its lock, in one pass however many nodes went.
pub(crate) fn sweep_anchored(doc: &LoroDoc, ids: &BTreeSet<String>) -> Step {
    if ids.is_empty() {
        return Ok(());
    }
    sweep_plane(doc, EDGE_PLANE, stored::edge, ids)?;
    sweep_plane(doc, LINE_PLANE, stored::line, ids)
}

/// `deleteSpatialNode`: the node, its lock and what is anchored on it, in one
/// commit; nothing for an absent id.
pub(crate) fn delete_node(doc: &LoroDoc, id: &str) -> Step {
    if !holds(doc, NODES, id) {
        return Ok(());
    }
    refuse_retired_edges(doc)?;
    if !delete_element(doc, NODE_PLANE, id)? {
        return Ok(());
    }
    sweep_anchored(doc, &BTreeSet::from([id.to_owned()]))?;
    doc.commit();
    Ok(())
}

/// JavaScript's truthiness of a JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(Value::String(s) | Value::BigInt(s)) => !s.is_empty(),
        Some(Value::Seq(_) | Value::Map(_)) => true,
    }
}

/// `setNodeLock` and `setEdgeLock`: writing the value held is no op and no
/// commit.
pub(crate) fn set_lock(doc: &LoroDoc, locks: &str, id: &str, locked: Option<&Value>) -> Step {
    let held =
        matches!(doc.get_map(locks).get(id), Some(ValueOrContainer::Value(LoroValue::Bool(true))));
    if locked == Some(&Value::Bool(held)) {
        return Ok(());
    }
    if truthy(locked) {
        set(doc, locks, id, &Value::Bool(true))?;
    } else {
        delete(doc, locks, id)?;
    }
    doc.commit();
    Ok(())
}

/// `writeOptionalField`: set when given, removed only when something is there.
fn write_optional(doc: &LoroDoc, key: &str, value: Option<&Value>) -> Step {
    match value {
        Some(value) => set(doc, CANVAS, key, value),
        None if holds(doc, CANVAS, key) => delete(doc, CANVAS, key),
        None => Ok(()),
    }
}

/// `setEvery`: every incoming element written, answering the ids held before
/// and not incoming, read before the writes in the map's own order.
fn set_every(doc: &LoroDoc, plane: Plane, elements: &[Value]) -> Result<Vec<String>, Fault> {
    let mut stale: Vec<String> = doc.get_map(plane.map).keys().map(|k| k.to_string()).collect();
    for element in elements {
        let id = text(field(element, "id"))?;
        stale.retain(|held| held != id);
        set(doc, plane.map, id, &(plane.fields)(element)?)?;
    }
    Ok(stale)
}

/// `dropEvery`: each stale element and the lock that named it.
fn drop_every(doc: &LoroDoc, plane: Plane, stale: &[String]) -> Step {
    for id in stale {
        delete(doc, plane.map, id)?;
        drop_lock(doc, plane.locks, id)?;
    }
    Ok(())
}

/// The lines a canvas argument holds: `canvas.lines ?? []`.
pub(crate) fn lines_of(canvas: &Value) -> Result<&[Value], Fault> {
    match field(canvas, "lines") {
        None | Some(Value::Null) => Ok(&[]),
        held => items(held),
    }
}

/// `writeSpatialCanvas`: the whole truth of the canvas, every collection's
/// writes before every collection's removals, in one commit.
pub(crate) fn write_canvas(doc: &LoroDoc, canvas: &Value) -> Step {
    refuse_reserved_key(canvas)?;
    if !matches!(canvas, Value::Map(_)) {
        return Err(Fault::Declined);
    }
    write_optional(doc, FACETS_FIELD, field(canvas, FACETS_FIELD))?;
    write_optional(doc, TAGS_FIELD, field(canvas, TAGS_FIELD))?;
    let stale_nodes = set_every(doc, NODE_PLANE, items(field(canvas, "nodes"))?)?;
    let stale_edges = set_every(doc, EDGE_PLANE, items(field(canvas, "edges"))?)?;
    let stale_lines = set_every(doc, LINE_PLANE, lines_of(canvas)?)?;
    drop_every(doc, NODE_PLANE, &stale_nodes)?;
    drop_every(doc, EDGE_PLANE, &stale_edges)?;
    drop_every(doc, LINE_PLANE, &stale_lines)?;
    doc.commit();
    Ok(())
}

/// `writeCanvasFacetsField`: `next` over the stored entries this build cannot
/// read, which it leaves alone; the field goes when nothing is left.
pub(crate) fn write_canvas_facets(doc: &LoroDoc, next: Option<&Value>) -> Step {
    if let Some(next) = next {
        refuse_reserved_key(next)?;
    }
    let given = match next {
        None | Some(Value::Null) => &[][..],
        Some(Value::Map(entries)) => entries.as_slice(),
        Some(_) => return Err(Fault::Declined),
    };
    let stored = doc.get_map(CANVAS).get(FACETS_FIELD).and_then(value_of);
    let mut merged: Vec<(String, Value)> = Vec::new();
    if let Some(LoroValue::Map(stored)) = stored {
        for (key, held) in stored.iter().filter(|(k, _)| !stored::is_readable_facet_key(k)) {
            // Bytes or a container id would not survive the trip back as a value.
            crate::plain::plain(held).ok_or(Fault::Declined)?;
            merged.push((key.clone(), loro_value_to_value(held)));
        }
    }
    for (key, value) in given {
        match merged.iter_mut().find(|(k, _)| k == key) {
            Some(entry) => entry.1 = value.clone(),
            None => merged.push((key.clone(), value.clone())),
        }
    }
    if merged.is_empty() {
        delete(doc, CANVAS, FACETS_FIELD)
    } else {
        set(doc, CANVAS, FACETS_FIELD, &enumeration_order(Value::Map(merged)))
    }
}

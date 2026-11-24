//! The spatial writes that share one commit: `withSpatialBatch`'s writer and
//! `reconcileSpatialCanvas`, the visible-diff write that never touches a
//! record the reader could not show.
//!
//! A node removal's sweep of what is anchored on it is deferred to the next
//! write of any other kind, or to the end, so a run of removals sweeps once;
//! deferring no further than the next write keeps every write seeing the canvas
//! it would have seen had each removal swept at once.

use crate::host::Host;
use crate::spatial_write::{
    CANVAS, EDGE_PLANE, Fault, LINE_PLANE, NODE_PLANE, NODES, Plane, Step, delete, delete_element,
    field, holds, items, lines_of, refuse_reserved_key, refuse_retired_edges, set, sweep_anchored,
    text, write_canvas_facets, write_element,
};
use std::collections::BTreeSet;
use whiteboard_model::Value;

/// `spatialBatchWriter`: uncommitted writes, and whether any changed the doc.
pub(crate) struct BatchWriter<'a> {
    host: &'a Host<'a>,
    removed: BTreeSet<String>,
    pub(crate) wrote: bool,
}

impl<'a> BatchWriter<'a> {
    pub(crate) fn new(host: &'a Host<'a>) -> Self {
        Self { host, removed: BTreeSet::new(), wrote: false }
    }

    /// Sweeps what the removals so far left anchored on nothing.
    pub(crate) fn settle(&mut self) -> Step {
        sweep_anchored(self.host, &self.removed)?;
        self.removed.clear();
        Ok(())
    }

    /// `writeNode`, `writeEdge` and `writeLine`.
    pub(crate) fn write(&mut self, plane: Plane, element: &Value) -> Step {
        self.settle()?;
        write_element(self.host, plane, element)?;
        self.wrote = true;
        Ok(())
    }

    /// `deleteNode`: its sweep waits; the retired-edge refusal is asked once
    /// per run of removals, before the first.
    pub(crate) fn delete_node(&mut self, id: &str) -> Step {
        if !holds(self.host, NODES, id)? {
            return Ok(());
        }
        if self.removed.is_empty() {
            refuse_retired_edges(self.host)?;
        }
        if !delete_element(self.host, NODE_PLANE, id)? {
            return Ok(());
        }
        self.removed.insert(id.to_owned());
        self.wrote = true;
        Ok(())
    }

    /// `deleteEdge` and `deleteLine`: absent ids write nothing.
    pub(crate) fn delete(&mut self, plane: Plane, id: &str) -> Step {
        self.settle()?;
        if delete_element(self.host, plane, id)? {
            self.wrote = true;
        }
        Ok(())
    }

    fn remove(&mut self, plane: Plane, id: &str) -> Step {
        if plane.is_nodes() { self.delete_node(id) } else { self.delete(plane, id) }
    }
}

/// `withSpatialBatch` over the engine's steps: `writeNode`, `writeEdge`,
/// `deleteNode`, and any other op read as `deleteEdge`, as the TypeScript's
/// dispatch reads it. One commit, and none when nothing was written.
pub(crate) fn with_spatial_batch(host: &Host<'_>, steps: &[Value]) -> Step {
    let mut writer = BatchWriter::new(host);
    for step in steps {
        if !matches!(step, Value::Map(_)) {
            return Err(Fault::Declined);
        }
        match field(step, "op") {
            Some(Value::String(op)) if op == "writeNode" => {
                writer.write(NODE_PLANE, field(step, "node").ok_or(Fault::Declined)?)?;
            }
            Some(Value::String(op)) if op == "writeEdge" => {
                writer.write(EDGE_PLANE, field(step, "edge").ok_or(Fault::Declined)?)?;
            }
            Some(Value::String(op)) if op == "deleteNode" => {
                writer.delete_node(text(field(step, "id"))?)?;
            }
            _ => writer.delete(EDGE_PLANE, text(field(step, "id"))?)?,
        }
    }
    writer.settle()?;
    if writer.wrote {
        host.commit();
    }
    Ok(())
}

/// `sameValue`: equal as `JSON.stringify` writes them, keys in their order.
fn same_value(a: Option<&Value>, b: Option<&Value>) -> bool {
    a == b
}

/// `reconcileById`: what is new or changed written, then what `prev` held and
/// `next` does not removed, in `prev`'s order.
fn reconcile_by_id(
    writer: &mut BatchWriter<'_>,
    plane: Plane,
    prev: &[Value],
    next: &[Value],
) -> Step {
    let mut before: Vec<(&str, &Value)> = Vec::new();
    for item in prev {
        let id = text(field(item, "id"))?;
        match before.iter_mut().find(|(held, _)| *held == id) {
            Some(entry) => entry.1 = item,
            None => before.push((id, item)),
        }
    }
    let kept: BTreeSet<&str> =
        next.iter().map(|item| text(field(item, "id"))).collect::<Result<_, _>>()?;
    for item in next {
        let id = text(field(item, "id"))?;
        let was = before.iter().find(|(held, _)| *held == id).map(|(_, v)| *v);
        if !same_value(was, Some(item)) {
            writer.write(plane, item)?;
        }
    }
    for (id, _) in &before {
        if !kept.contains(id) {
            writer.remove(plane, id)?;
        }
    }
    Ok(())
}

/// `reconcileSpatialCanvasInto`: whether it wrote anything; the caller owns
/// the commit.
pub(crate) fn reconcile_into(host: &Host<'_>, prev: &Value, next: &Value) -> Result<bool, Fault> {
    refuse_reserved_key(next)?;
    let mut writer = BatchWriter::new(host);
    reconcile_by_id(
        &mut writer,
        NODE_PLANE,
        items(field(prev, "nodes"))?,
        items(field(next, "nodes"))?,
    )?;
    reconcile_by_id(
        &mut writer,
        EDGE_PLANE,
        items(field(prev, "edges"))?,
        items(field(next, "edges"))?,
    )?;
    reconcile_by_id(&mut writer, LINE_PLANE, lines_of(prev)?, lines_of(next)?)?;
    writer.settle()?;
    let facets_moved = !same_value(field(prev, "facets"), field(next, "facets"));
    let tags_moved = !same_value(field(prev, "tags"), field(next, "tags"));
    if !facets_moved && !tags_moved {
        return Ok(writer.wrote);
    }
    if facets_moved {
        write_canvas_facets(host, field(next, "facets"))?;
    }
    if tags_moved {
        match field(next, "tags") {
            Some(tags) => set(host, CANVAS, "tags", tags)?,
            None => delete(host, CANVAS, "tags")?,
        }
    }
    Ok(true)
}

/// `reconcileSpatialCanvas`: one commit, none for an unchanged canvas.
pub(crate) fn reconcile(host: &Host<'_>, prev: &Value, next: &Value) -> Step {
    if reconcile_into(host, prev, next)? {
        host.commit();
    }
    Ok(())
}

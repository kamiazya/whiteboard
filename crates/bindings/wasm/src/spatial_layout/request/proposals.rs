//! The proposal layer a request carries (`proposals`): each proposal as
//! `proposalSchema` stores it, less what no layout reads (its author and
//! timestamp, and a passage change's anchor, text and prior, since the canvas
//! only counts one), which the request gate leaves off. A change's nodes,
//! edges and lines are read as the canvas's own are.

use whiteboard_model::Value;
use whiteboard_model::proposal::{
    ChangeOp, ChangeStatus, ElementPatchFields, NodePatchFields, Proposal, ProposedChange,
    SpatialChange,
};
use whiteboard_model::spatial::BackgroundStyle;

use crate::json_canvas_wire::{
    Fields, bends_of, color_of, edge_end_of, edge_of, facets_of, items_of, line_end_of, line_of,
    node_of, number_of, string_of,
};

fn status_of(value: &Value) -> Option<ChangeStatus> {
    match string_of(value)?.as_str() {
        "open" => Some(ChangeStatus::Open),
        "adopted" => Some(ChangeStatus::Adopted),
        "dismissed" => Some(ChangeStatus::Dismissed),
        _ => None,
    }
}

fn node_patch_of(value: &Value) -> Option<NodePatchFields> {
    let mut f = Fields::of(value)?;
    let patch = NodePatchFields {
        x: f.field("x", number_of)?,
        y: f.field("y", number_of)?,
        width: f.field("width", number_of)?,
        height: f.field("height", number_of)?,
        color: f.field("color", color_of)?,
        text: f.field("text", string_of)?,
        file: f.field("file", string_of)?,
        subpath: f.field("subpath", string_of)?,
        url: f.field("url", string_of)?,
        label: f.field("label", string_of)?,
        background: f.field("background", string_of)?,
        background_style: f
            .field("backgroundStyle", |v| BackgroundStyle::from_wire(&string_of(v)?))?,
    };
    f.all_named().then_some(patch)
}

fn element_patch_of<End>(
    value: &Value,
    end_of: fn(&Value) -> Option<End>,
) -> Option<ElementPatchFields<End>> {
    let mut f = Fields::of(value)?;
    let patch = ElementPatchFields {
        from: f.field("from", end_of)?,
        to: f.field("to", end_of)?,
        color: f.field("color", color_of)?,
        label: f.field("label", string_of)?,
        bends: f.field("bends", bends_of)?,
        facets: f.field("facets", facets_of)?,
    };
    f.all_named().then_some(patch)
}

/// A node arm by its verb; `None` for one that is malformed or no node arm.
fn node_change(op: &str, f: &mut Fields<'_>) -> Option<SpatialChange> {
    Some(match op {
        "node.add" => SpatialChange::NodeAdd { node: f.field("node", node_of)?? },
        "node.patch" => SpatialChange::NodePatch {
            node_id: f.field("nodeId", string_of)??,
            patch: f.field("patch", node_patch_of)??,
            assumed: f.field("assumed", node_patch_of)??,
        },
        "node.remove" => SpatialChange::NodeRemove {
            node_id: f.field("nodeId", string_of)??,
            assumed: f.field("assumed", node_of)??,
        },
        _ => return None,
    })
}

fn edge_change(op: &str, f: &mut Fields<'_>) -> Option<SpatialChange> {
    let patch = |v: &Value| element_patch_of(v, edge_end_of);
    Some(match op {
        "edge.add" => SpatialChange::EdgeAdd { edge: f.field("edge", edge_of)?? },
        "edge.patch" => SpatialChange::EdgePatch {
            edge_id: f.field("edgeId", string_of)??,
            patch: f.field("patch", patch)??,
            assumed: f.field("assumed", patch)??,
        },
        "edge.remove" => SpatialChange::EdgeRemove {
            edge_id: f.field("edgeId", string_of)??,
            assumed: f.field("assumed", edge_of)??,
        },
        _ => return None,
    })
}

fn line_change(op: &str, f: &mut Fields<'_>) -> Option<SpatialChange> {
    let patch = |v: &Value| element_patch_of(v, line_end_of);
    Some(match op {
        "line.add" => SpatialChange::LineAdd { line: f.field("line", line_of)?? },
        "line.patch" => SpatialChange::LinePatch {
            line_id: f.field("lineId", string_of)??,
            patch: f.field("patch", patch)??,
            assumed: f.field("assumed", patch)??,
        },
        "line.remove" => SpatialChange::LineRemove {
            line_id: f.field("lineId", string_of)??,
            assumed: f.field("assumed", line_of)??,
        },
        _ => return None,
    })
}

fn op_of(op: &str, f: &mut Fields<'_>) -> Option<ChangeOp> {
    if op == "body.replace" {
        return Some(ChangeOp::BodyReplace);
    }
    let spatial = match op.split_once('.')?.0 {
        "node" => node_change(op, f),
        "edge" => edge_change(op, f),
        "line" => line_change(op, f),
        _ => None,
    };
    Some(ChangeOp::Spatial(Box::new(spatial?)))
}

fn change_of(value: &Value) -> Option<ProposedChange> {
    let mut f = Fields::of(value)?;
    let id = f.field("id", string_of)??;
    let status = f.field("status", status_of)??;
    let op = f.field("op", string_of)??;
    let change = ProposedChange { id, status, op: op_of(&op, &mut f)? };
    f.all_named().then_some(change)
}

fn proposal_of(value: &Value) -> Option<Proposal> {
    let mut f = Fields::of(value)?;
    let proposal = Proposal {
        id: f.field("id", string_of)??,
        changes: f.field("changes", |v| items_of(v, change_of))??,
    };
    f.all_named().then_some(proposal)
}

/// A request's `proposals`; `None` when one is malformed.
pub(super) fn proposals_of(value: &Value) -> Option<Vec<Proposal>> {
    items_of(value, proposal_of)
}

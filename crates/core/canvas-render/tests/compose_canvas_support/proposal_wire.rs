//! A recorded proposal, read into the model: its changes' nodes, edges and
//! lines as the canvas wire writes them, a patch's doubles as the hex of their
//! bits.

use serde::Deserialize;
use serde_json::Value;
use whiteboard_model::proposal::{
    ChangeOp, ChangeStatus, ElementPatchFields, NodePatchFields, Proposal, ProposedChange,
    SpatialChange,
};
use whiteboard_model::spatial::BackgroundStyle;

use crate::canvas_wire::{
    ElementWire, EndWire, NodeWire, Res, color_of, edge_end_of, edge_of, f64_of, line_end_of,
    line_of, node_of, point_of,
};
use crate::facet_support::facets_of;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ChangeWire {
    id: String,
    status: String,
    op: String,
    node: Option<NodeWire>,
    node_id: Option<String>,
    edge: Option<ElementWire>,
    edge_id: Option<String>,
    line: Option<ElementWire>,
    line_id: Option<String>,
    patch: Option<Value>,
    assumed: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProposalWire {
    id: String,
    changes: Vec<ChangeWire>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct NodePatchWire {
    x: Option<String>,
    y: Option<String>,
    width: Option<String>,
    height: Option<String>,
    color: Option<String>,
    text: Option<String>,
    file: Option<String>,
    subpath: Option<String>,
    url: Option<String>,
    label: Option<String>,
    background: Option<String>,
    background_style: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ElementPatchWire {
    from: Option<EndWire>,
    to: Option<EndWire>,
    color: Option<String>,
    label: Option<String>,
    bends: Option<Vec<[String; 2]>>,
    facets: Option<Value>,
}

fn parse<T: for<'de> Deserialize<'de>>(value: Option<&Value>) -> Res<T> {
    serde_json::from_value(value.cloned().ok_or("a patch or prior is missing")?)
        .map_err(|e| e.to_string())
}

fn node_patch_of(value: Option<&Value>) -> Res<NodePatchFields> {
    let wire: NodePatchWire = parse(value)?;
    let number = |hex: &Option<String>| hex.as_deref().map(f64_of).transpose();
    let background_style = wire
        .background_style
        .as_deref()
        .map(|s| BackgroundStyle::from_wire(s).ok_or(format!("background style {s}")))
        .transpose()?;
    Ok(NodePatchFields {
        x: number(&wire.x)?,
        y: number(&wire.y)?,
        width: number(&wire.width)?,
        height: number(&wire.height)?,
        color: wire.color.as_deref().map(color_of),
        text: wire.text,
        file: wire.file,
        subpath: wire.subpath,
        url: wire.url,
        label: wire.label,
        background: wire.background,
        background_style,
    })
}

fn element_patch_of<End>(
    value: Option<&Value>,
    end_of: fn(&EndWire) -> Res<End>,
) -> Res<ElementPatchFields<End>> {
    let wire: ElementPatchWire = parse(value)?;
    Ok(ElementPatchFields {
        from: wire.from.as_ref().map(end_of).transpose()?,
        to: wire.to.as_ref().map(end_of).transpose()?,
        color: wire.color.as_deref().map(color_of),
        label: wire.label,
        bends: wire.bends.map(|b| b.iter().map(point_of).collect()).transpose()?,
        facets: facets_of(wire.facets.as_ref()),
    })
}

fn id_of(id: Option<&String>) -> Res<String> {
    id.cloned().ok_or_else(|| "a change names no element".to_owned())
}

fn some<T>(value: Option<&T>) -> Res<&T> {
    value.ok_or_else(|| "a change carries no element".to_owned())
}

fn spatial_of(wire: &ChangeWire) -> Res<SpatialChange> {
    let (patch, prior) = (wire.patch.as_ref(), wire.assumed.as_ref());
    let whole = |value: Option<&Value>| -> Res<Value> { Ok(some(value)?.clone()) };
    Ok(match wire.op.as_str() {
        "node.add" => SpatialChange::NodeAdd { node: node_of(some(wire.node.as_ref())?)? },
        "node.patch" => SpatialChange::NodePatch {
            node_id: id_of(wire.node_id.as_ref())?,
            patch: node_patch_of(patch)?,
            assumed: node_patch_of(prior)?,
        },
        "node.remove" => SpatialChange::NodeRemove {
            node_id: id_of(wire.node_id.as_ref())?,
            assumed: node_of(&parse(Some(&whole(prior)?))?)?,
        },
        "edge.add" => SpatialChange::EdgeAdd { edge: edge_of(some(wire.edge.as_ref())?)? },
        "edge.patch" => SpatialChange::EdgePatch {
            edge_id: id_of(wire.edge_id.as_ref())?,
            patch: element_patch_of(patch, edge_end_of)?,
            assumed: element_patch_of(prior, edge_end_of)?,
        },
        "edge.remove" => SpatialChange::EdgeRemove {
            edge_id: id_of(wire.edge_id.as_ref())?,
            assumed: edge_of(&parse(Some(&whole(prior)?))?)?,
        },
        "line.add" => SpatialChange::LineAdd { line: line_of(some(wire.line.as_ref())?)? },
        "line.patch" => SpatialChange::LinePatch {
            line_id: id_of(wire.line_id.as_ref())?,
            patch: element_patch_of(patch, line_end_of)?,
            assumed: element_patch_of(prior, line_end_of)?,
        },
        "line.remove" => SpatialChange::LineRemove {
            line_id: id_of(wire.line_id.as_ref())?,
            assumed: line_of(&parse(Some(&whole(prior)?))?)?,
        },
        other => return Err(format!("op {other}")),
    })
}

pub(crate) fn change_of(wire: &ChangeWire) -> Res<ProposedChange> {
    let status = match wire.status.as_str() {
        "open" => ChangeStatus::Open,
        "adopted" => ChangeStatus::Adopted,
        "dismissed" => ChangeStatus::Dismissed,
        other => return Err(format!("status {other}")),
    };
    let op = if wire.op == "body.replace" {
        ChangeOp::BodyReplace
    } else {
        ChangeOp::Spatial(Box::new(spatial_of(wire)?))
    };
    Ok(ProposedChange { id: wire.id.clone(), status, op })
}

pub(crate) fn proposal_of(wire: &ProposalWire) -> Res<Proposal> {
    Ok(Proposal {
        id: wire.id.clone(),
        changes: wire.changes.iter().map(change_of).collect::<Res<_>>()?,
    })
}

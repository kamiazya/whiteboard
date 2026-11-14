//! The proposal layer (`layout/proposals.ts`, ADR-0029 decision 1): every
//! OPEN change outlined where it would land, and one bubble per proposal
//! saying how many changes it holds and how many need a look.
//!
//! Drawn on the live document rather than in a preview of a second one, in
//! the comment layer's grammar and with its constants, placement and body
//! producer: a reader who has used a comment has already learned how to read
//! this. A decided change draws nothing, and a proposal whose changes are all
//! decided has no bubble.

use whiteboard_model::node_content::is_frame;
use whiteboard_model::proposal::{
    ChangeOp, ChangeStatus, ProposedChange, SpatialChange, canvas_change_conflicts,
};
use whiteboard_model::spatial::{CanvasLine, EdgeSide, LineEnd, SpatialCanvas, SpatialNode};
use whiteboard_scene::{
    Appearance, BoundingBox, EdgeEnd, ProposalChrome, ResolvedEdgeNode, SceneNode, ScenePoint,
    ShapeSceneNode,
};

use crate::comments::body::{CommentDensity, layout_comment_body};
use crate::comments::placement::{comment_leader_end, place_comment_bubble};
use crate::comments::{COMMENT_BUBBLE_PADDING_PX, COMMENT_BUBBLE_RADIUS_PX, edge_path};
use crate::compose_node::ComposeOptions;
use crate::scene_extent::content_extent;
use crate::theme::appearance::SpatialProposalAppearance;
use crate::translate_scene::translate_scene;

/// The width a proposal's bubble measures to: the narrowest that still fits
/// `1 proposed change` on one line, since it carries a count rather than prose.
pub const PROPOSAL_TEXT_MAX_WIDTH_PX: f64 = 145.0;

fn box_of(node: &SpatialNode) -> BoundingBox {
    BoundingBox { x: node.x, y: node.y, w: node.width, h: node.height }
}

fn centre_of(node: &SpatialNode) -> ScenePoint {
    ScenePoint { x: node.x + node.width / 2.0, y: node.y + node.height / 2.0 }
}

/// The box a change concerns (`proposedBox`): where an addition would appear,
/// where a patch would leave the node (drawn at its DESTINATION, the node left
/// where it is), and where a removal would take it from. None for an edge or
/// line arm, which has a route rather than a box.
fn proposed_box(change: &SpatialChange, canvas: &SpatialCanvas) -> Option<BoundingBox> {
    let node = |id: &str| canvas.nodes.iter().find(|node| node.id == id);
    match change {
        SpatialChange::NodeAdd { node: added } => Some(box_of(added)),
        SpatialChange::NodePatch { node_id, patch, .. } => node(node_id).map(|held| BoundingBox {
            x: patch.x.unwrap_or(held.x),
            y: patch.y.unwrap_or(held.y),
            w: patch.width.unwrap_or(held.width),
            h: patch.height.unwrap_or(held.height),
        }),
        SpatialChange::NodeRemove { node_id, .. } => node(node_id).map(box_of),
        _ => None,
    }
}

/// The route a proposed edge or line traces (`proposedEdgePath`): one already
/// on the board along the path it was drawn on, a new one straight between
/// the centres of what it joins (a line's free end at its point). An end
/// naming no node draws no preview, as a dangling reference does.
fn proposed_path(
    change: &SpatialChange,
    canvas: &SpatialCanvas,
    edges: &[SceneNode],
) -> Option<Vec<ScenePoint>> {
    let centre = |id: &str| canvas.nodes.iter().find(|node| node.id == id).map(centre_of);
    let at = |end: &LineEnd| match end {
        LineEnd::LineEndPoint(free) => Some(ScenePoint { x: free.point.x, y: free.point.y }),
        LineEnd::LineEndNode(on) => centre(&on.node),
    };
    match change {
        SpatialChange::EdgePatch { edge_id: id, .. }
        | SpatialChange::EdgeRemove { edge_id: id, .. }
        | SpatialChange::LinePatch { line_id: id, .. }
        | SpatialChange::LineRemove { line_id: id, .. } => edge_path(edges, id),
        SpatialChange::LineAdd { line: CanvasLine { from, to, .. } } => {
            Some(vec![at(from)?, at(to)?])
        }
        SpatialChange::EdgeAdd { edge } => {
            Some(vec![centre(&edge.from.node)?, centre(&edge.to.node)?])
        }
        _ => None,
    }
}

fn shape(id: String, proposal_id: &str, bbox: BoundingBox, paint: Option<Appearance>) -> SceneNode {
    SceneNode::Shape(Box::new(ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: Some(id),
        bbox,
        comment_chrome: false,
        proposal_chrome: Some(ProposalChrome { proposal_id: proposal_id.to_owned() }),
        radius: Some(COMMENT_BUBBLE_RADIUS_PX),
        shape: None,
        appearance: paint,
        task_box: None,
        ink: None,
    }))
}

fn line(id: String, path: Vec<ScenePoint>, paint: Option<Appearance>) -> SceneNode {
    SceneNode::Edge(Box::new(ResolvedEdgeNode {
        id,
        jumps: None,
        path,
        from_side: EdgeSide::Right,
        to_side: EdgeSide::Left,
        from_end: EdgeEnd::None,
        to_end: EdgeEnd::None,
        rounded: false,
        ink: None,
        comment_chrome: false,
        appearance: paint,
    }))
}

/// One change's outline, the box it adds to what a bubble avoids, and where a
/// bubble would anchor to it.
struct Outline {
    node: SceneNode,
    bbox: Option<BoundingBox>,
    anchor: Option<ScenePoint>,
}

/// One change outlined (`changeOutline`): the box it concerns, anchored at its
/// top-right corner, else the route it traces, anchored at its middle point.
fn change_outline(
    proposal_id: &str,
    change: &ProposedChange,
    spatial: &SpatialChange,
    drawn: &Drawn<'_>,
    paint: Option<&Appearance>,
) -> Option<Outline> {
    let id = format!("{}/outline", change.id);
    let paint = paint.cloned();
    if let Some(bbox) = proposed_box(spatial, drawn.canvas) {
        let anchor = ScenePoint { x: bbox.x + bbox.w, y: bbox.y };
        let node = shape(id, proposal_id, bbox, paint);
        return Some(Outline { node, bbox: Some(bbox), anchor: Some(anchor) });
    }
    let path = proposed_path(spatial, drawn.canvas, drawn.edges)?;
    let anchor = path.get(path.len() / 2).copied();
    Some(Outline { node: line(id, path, paint), bbox: None, anchor })
}

/// What the layer reads of the walk: the canvas, and the edges it drew.
struct Drawn<'d> {
    canvas: &'d SpatialCanvas,
    edges: &'d [SceneNode],
}

/// A proposal's open changes outlined, where its bubble anchors (the first
/// outline that has a point), and how many of them conflict.
struct Outlined {
    nodes: Vec<SceneNode>,
    boxes: Vec<BoundingBox>,
    anchor: Option<ScenePoint>,
    conflicts: usize,
}

fn outline_changes(
    proposal_id: &str,
    open: &[&ProposedChange],
    drawn: &Drawn<'_>,
    paint: Option<&Appearance>,
) -> Outlined {
    let mut outlined =
        Outlined { nodes: Vec::new(), boxes: Vec::new(), anchor: None, conflicts: 0 };
    for change in open {
        let ChangeOp::Spatial(spatial) = &change.op else { continue };
        if canvas_change_conflicts(spatial, drawn.canvas) {
            outlined.conflicts = outlined.conflicts.saturating_add(1);
        }
        let Some(outline) = change_outline(proposal_id, change, spatial, drawn, paint) else {
            continue;
        };
        outlined.nodes.push(outline.node);
        outlined.boxes.extend(outline.bbox);
        outlined.anchor = outlined.anchor.or(outline.anchor);
    }
    outlined
}

/// What a bubble says: how many changes are open, and how many need a look.
fn label_of(open: usize, conflicts: usize) -> String {
    let changed = format!("{open} proposed change{}", if open == 1 { "" } else { "s" });
    if conflicts == 0 { changed } else { format!("{changed}, {conflicts} needs a look") }
}

/// The bubble (`proposalBubble`): its label wrapped through the comment body's
/// own producer at panel density, placed clear of `obstacles`, which it then
/// joins; then the leader, the box and the label inside it.
fn proposal_bubble(
    proposal_id: &str,
    label: &str,
    anchor: ScenePoint,
    obstacles: &mut Vec<BoundingBox>,
    chrome: Option<&SpatialProposalAppearance>,
    options: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let (width, density) = (PROPOSAL_TEXT_MAX_WIDTH_PX, CommentDensity::Compact);
    let laid = layout_comment_body(proposal_id, label, width, density, options);
    let extent = content_extent(&laid);
    let room = 2.0 * COMMENT_BUBBLE_PADDING_PX;
    let bubble = place_comment_bubble(anchor, extent.right + room, extent.bottom + room, obstacles);
    obstacles.push(bubble);
    let end = comment_leader_end(anchor, &bubble, COMMENT_BUBBLE_RADIUS_PX);
    let mut out = vec![
        line(format!("{proposal_id}/leader"), vec![anchor, end], chrome.map(|c| c.leader.clone())),
        shape(
            format!("{proposal_id}/bubble"),
            proposal_id,
            bubble,
            chrome.map(|c| c.bubble.clone()),
        ),
    ];
    out.extend(translate_scene(
        &laid,
        bubble.x + COMMENT_BUBBLE_PADDING_PX,
        bubble.y + COMMENT_BUBBLE_PADDING_PX,
    ));
    out
}

/// The proposal layer over `canvas` (`composeProposals`), given the edges the
/// walk drew: each proposal with an open change outlines them, and one with an
/// outline to anchor to draws its bubble clear of every box, every earlier
/// outline and every earlier bubble.
#[must_use]
pub fn compose_proposals(
    canvas: &SpatialCanvas,
    edges: &[SceneNode],
    options: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let chrome = options.node_box.appearance.resolve_proposal();
    let paint = chrome.as_ref().map(|c| &c.outline);
    let drawn = Drawn { canvas, edges };
    let mut obstacles: Vec<BoundingBox> =
        canvas.nodes.iter().filter(|node| !is_frame(node)).map(box_of).collect();
    let mut out = Vec::new();
    for proposal in options.layout.proposals {
        let open: Vec<&ProposedChange> =
            proposal.changes.iter().filter(|c| c.status == ChangeStatus::Open).collect();
        let outlined = outline_changes(&proposal.id, &open, &drawn, paint);
        out.extend(outlined.nodes);
        obstacles.extend(outlined.boxes);
        let Some(anchor) = outlined.anchor else { continue };
        let label = label_of(open.len(), outlined.conflicts);
        out.extend(proposal_bubble(
            &proposal.id,
            &label,
            anchor,
            &mut obstacles,
            chrome.as_ref(),
            options,
        ));
    }
    out
}

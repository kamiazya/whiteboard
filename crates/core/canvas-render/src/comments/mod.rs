//! The comment layer (`layout/comments.ts`, ADR-0024/0025/0026): the outline a
//! node set or region thread draws, then per comment a dashed leader, a pin on
//! its anchor, the pin's count, and a bubble holding the opening message,
//! placed where it covers least. Drawn over the canvas the caller asked for and
//! never over one nested in it.
//!
//! Paint is assigned, never invented: every shape takes the resolver's
//! `resolve_comment` (its resolved overlay for a settled thread), and a
//! resolver that has none still lays the geometry out, bare.
//!
//! A bubble's body is the host's
//! ([`crate::compose_node::ComposeHost::comment_body`]): the opening
//! message laid out at the origin, a settled one collapsed to its first line.

pub mod placement;
mod regions;

use whiteboard_model::annotation::{
    CommentThread, PlacedComment, canvas_comments_of, comment_corner_of,
};
use whiteboard_model::spatial::{EdgeSide, SpatialCanvas};
use whiteboard_scene::{
    Appearance, BoundingBox, EdgeEnd, ResolvedEdgeNode, SceneNode, ScenePoint, ShapeSceneNode,
    TextRunNode,
};

use crate::compose_node::ComposeOptions;
use crate::edge_flatten::flatten_drawn_edge_path;
use crate::measure::{FontDescriptor, FontStyle};
use crate::node_content::is_frame;
use crate::scene_extent::content_extent;
use crate::theme::appearance::{SpatialCommentAppearance, SpatialCommentChromeAppearance};
use crate::translate_scene::translate_scene;
use placement::{comment_leader_end, nearest_point_on_polyline, place_comment_bubble};
use regions::{Region, region_outlines, regions_of};

/// Pin diameter: a mark, not content.
pub const COMMENT_PIN_SIZE_PX: f64 = 20.0;
const COMMENT_PIN_RADIUS_PX: f64 = COMMENT_PIN_SIZE_PX / 2.0;
/// The digits on a pin, sized to sit inside it with its ring.
const COMMENT_PIN_COUNT_FONT_PX: f64 = 10.0;
pub const COMMENT_BUBBLE_PADDING_PX: f64 = 8.0;
pub const COMMENT_BUBBLE_RADIUS_PX: f64 = 8.0;
/// A bubble's room beyond its body: the padding on both sides.
const COMMENT_BUBBLE_ROOM_PX: f64 = 2.0 * COMMENT_BUBBLE_PADDING_PX;

/// What a caller says about the comment layer (`threads`, `showResolved`,
/// `commentObstacles`); no threads is the layer switched off.
#[derive(Debug, Clone, Copy, Default)]
pub struct CommentOptions<'a> {
    /// The document's threads, in the order that decides which bubble yields.
    pub threads: &'a [CommentThread],
    /// Settled threads are drawn, muted, rather than left out.
    pub show_resolved: bool,
    /// What a bubble must keep clear of besides the canvas's own boxes.
    pub obstacles: &'a [BoundingBox],
}

/// What the walk drew that the layer reads: everything, and the edge pass's
/// share of it.
pub struct Drawn<'d> {
    /// Every node in paint order, then every edge and label.
    pub all: &'d [SceneNode],
    /// The edges and lines with their labels.
    pub edges: &'d [SceneNode],
}

/// The comment layer over `canvas`: the region outlines, then each visible
/// comment.
#[must_use]
pub fn compose_comment_layer(
    canvas: &SpatialCanvas,
    drawn: &Drawn<'_>,
    options: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let comments = &options.layout.comments;
    let chrome = options.node_box.appearance.resolve_comment();
    let regions = regions_of(comments.threads, canvas);
    let mut out = region_outlines(&regions, comments.show_resolved, chrome.as_ref());
    out.extend(compose_comments(canvas, drawn, options, &regions, chrome.as_ref()));
    out
}

/// The routed path an edge was drawn along, flattened as the reader sees it;
/// the last edge drawn under an id answers for it.
fn edge_path(edges: &[SceneNode], id: &str) -> Option<Vec<ScenePoint>> {
    edges.iter().rev().find_map(|node| match node {
        SceneNode::Edge(edge) if edge.id == id => Some(flatten_drawn_edge_path(
            &edge.path,
            edge.jumps.as_deref().unwrap_or_default(),
            edge.rounded,
        )),
        _ => None,
    })
}

/// Where a comment points (`commentAnchor`): the target node's corner while it
/// exists, the point of the target edge's path nearest the stored one while it
/// is drawn, else the stored point.
fn comment_anchor(
    comment: &PlacedComment,
    canvas: &SpatialCanvas,
    edges: &[SceneNode],
) -> ScenePoint {
    let stored = ScenePoint { x: comment.x, y: comment.y };
    if let Some(id) = &comment.target_node_id
        && let Some(node) = canvas.nodes.iter().find(|node| node.id == *id)
    {
        let corner = comment_corner_of(node.x, node.y, node.width);
        return ScenePoint { x: corner.x, y: corner.y };
    }
    let path = comment.target_edge_id.as_deref().and_then(|id| edge_path(edges, id));
    match path {
        Some(path) if !path.is_empty() => nearest_point_on_polyline(stored, &path),
        _ => stored,
    }
}

/// Where a comment's pin stands: a node set's or region's at the corner of the
/// box its live nodes occupy, read from the thread; any other at its anchor.
fn anchor_of(
    comment: &PlacedComment,
    canvas: &SpatialCanvas,
    edges: &[SceneNode],
    regions: &[Region],
) -> ScenePoint {
    match regions.iter().find(|region| region.thread_id == comment.id) {
        Some(region) => {
            let corner = comment_corner_of(region.rect.x, region.rect.y, region.rect.width);
            ScenePoint { x: corner.x, y: corner.y }
        }
        None => comment_anchor(comment, canvas, edges),
    }
}

fn pin_box(anchor: ScenePoint) -> BoundingBox {
    BoundingBox {
        x: anchor.x - COMMENT_PIN_RADIUS_PX,
        y: anchor.y - COMMENT_PIN_RADIUS_PX,
        w: COMMENT_PIN_SIZE_PX,
        h: COMMENT_PIN_SIZE_PX,
    }
}

/// What a bubble must not cover (`bubbleObstacles`): the words set outside any
/// box (a frame's name, an edge's label), every box but a frame (a comment
/// inside a group is about its members), what the caller adds, and every
/// visible pin up front, so a bubble drawn before a pin cannot cover it.
fn bubble_obstacles(
    canvas: &SpatialCanvas,
    drawn: &Drawn<'_>,
    extra: &[BoundingBox],
    anchors: &[ScenePoint],
) -> Vec<BoundingBox> {
    let labels = drawn.all.iter().filter_map(|node| match node {
        SceneNode::TextRun(run) if run.annotates.is_some() => Some(run.bbox),
        _ => None,
    });
    let boxes = canvas.nodes.iter().filter(|node| !is_frame(node)).map(|node| BoundingBox {
        x: node.x,
        y: node.y,
        w: node.width,
        h: node.height,
    });
    labels
        .chain(boxes)
        .chain(extra.iter().copied())
        .chain(anchors.iter().map(|anchor| pin_box(*anchor)))
        .collect()
}

/// The chrome a comment wears: the resolved overlay for a settled one.
fn wear<'c>(
    comment: &PlacedComment,
    chrome: Option<&'c SpatialCommentAppearance>,
) -> Option<&'c SpatialCommentChromeAppearance> {
    chrome.map(|c| if comment.resolved { &c.resolved_overlay } else { &c.chrome })
}

/// The digits on a pin, past one message only: a digit beside every lone
/// remark is noise.
fn pin_count_run(
    messages: usize,
    anchor: ScenePoint,
    appearance: Option<&SpatialCommentChromeAppearance>,
    options: &ComposeOptions<'_>,
) -> Option<SceneNode> {
    if messages <= 1 {
        return None;
    }
    let paint = appearance.and_then(|a| a.pin_count.clone());
    let text = messages.to_string();
    let family = paint.as_ref().and_then(|p| p.font_family.clone());
    let font = FontDescriptor {
        family: family.unwrap_or_else(|| "sans-serif".to_owned()),
        fallback_chain: Vec::new(),
        weight: 400.0,
        style: FontStyle::Normal,
        size_px: COMMENT_PIN_COUNT_FONT_PX,
    };
    let metrics = options.node_box.measure.measure(&text, &font);
    let (w, h) = (metrics.advance_width, metrics.ascent + metrics.descent);
    Some(SceneNode::TextRun(Box::new(TextRunNode {
        bbox: BoundingBox { x: anchor.x - w / 2.0, y: anchor.y - h / 2.0, w, h },
        baseline: Some(metrics.ascent),
        text,
        appearance: paint.map(|p| Appearance { font_size: Some(COMMENT_PIN_COUNT_FONT_PX), ..p }),
        ..crate::typeset::empty_run()
    })))
}

fn chrome_shape(
    id: String,
    bbox: BoundingBox,
    radius: f64,
    appearance: Option<Appearance>,
) -> SceneNode {
    SceneNode::Shape(Box::new(ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: Some(id),
        bbox,
        comment_chrome: true,
        proposal_chrome: None,
        radius: Some(radius),
        shape: None,
        appearance,
        task_box: None,
        ink: None,
    }))
}

/// The dashed line from the anchor to the bubble's near corner, drawn first so
/// pin and bubble paint over its ends.
fn leader(
    id: &str,
    anchor: ScenePoint,
    bubble: &BoundingBox,
    paint: Option<Appearance>,
) -> SceneNode {
    SceneNode::Edge(Box::new(ResolvedEdgeNode {
        id: format!("{id}/leader"),
        jumps: None,
        path: vec![anchor, comment_leader_end(anchor, bubble, COMMENT_BUBBLE_RADIUS_PX)],
        from_side: EdgeSide::Right,
        to_side: EdgeSide::Left,
        from_end: EdgeEnd::None,
        to_end: EdgeEnd::None,
        rounded: false,
        ink: None,
        comment_chrome: true,
        appearance: paint,
    }))
}

/// How many messages the thread a comment projects holds; the last thread
/// under an id answers for it, as a map keyed by id would.
fn messages_of(threads: &[CommentThread], id: &str) -> usize {
    threads.iter().rev().find(|thread| thread.id == id).map_or(1, |thread| thread.messages.len())
}

/// One comment: leader, pin, count, bubble, then its body inside the bubble.
fn compose_comment(
    comment: &PlacedComment,
    anchor: ScenePoint,
    obstacles: &mut Vec<BoundingBox>,
    options: &ComposeOptions<'_>,
    chrome: Option<&SpatialCommentAppearance>,
) -> Vec<SceneNode> {
    let appearance = wear(comment, chrome);
    let body = options.layout.host.comment_body(comment);
    let extent = content_extent(&body);
    let room = COMMENT_BUBBLE_ROOM_PX;
    let bubble = place_comment_bubble(anchor, extent.right + room, extent.bottom + room, obstacles);
    obstacles.push(bubble);
    let messages = messages_of(options.layout.comments.threads, &comment.id);
    let id = &comment.id;
    let mut out = vec![leader(id, anchor, &bubble, appearance.map(|a| a.leader.clone()))];
    let pin = appearance.map(|a| a.pin.clone());
    out.push(chrome_shape(format!("{id}/pin"), pin_box(anchor), COMMENT_PIN_RADIUS_PX, pin));
    out.extend(pin_count_run(messages, anchor, appearance, options));
    let paint = appearance.map(|a| a.bubble.clone());
    out.push(chrome_shape(format!("{id}/bubble"), bubble, COMMENT_BUBBLE_RADIUS_PX, paint));
    out.extend(translate_scene(
        &body,
        bubble.x + COMMENT_BUBBLE_PADDING_PX,
        bubble.y + COMMENT_BUBBLE_PADDING_PX,
    ));
    out
}

/// Every visible comment, in thread order: a later one fans out around an
/// earlier one's bubble.
fn compose_comments(
    canvas: &SpatialCanvas,
    drawn: &Drawn<'_>,
    options: &ComposeOptions<'_>,
    regions: &[Region],
    chrome: Option<&SpatialCommentAppearance>,
) -> Vec<SceneNode> {
    let layer = &options.layout.comments;
    let visible: Vec<PlacedComment> = canvas_comments_of(layer.threads, &canvas.nodes)
        .into_iter()
        .filter(|comment| !comment.resolved || layer.show_resolved)
        .collect();
    let anchors: Vec<ScenePoint> =
        visible.iter().map(|c| anchor_of(c, canvas, drawn.edges, regions)).collect();
    let mut obstacles = bubble_obstacles(canvas, drawn, layer.obstacles, &anchors);
    visible
        .iter()
        .zip(anchors)
        .flat_map(|(comment, anchor)| {
            compose_comment(comment, anchor, &mut obstacles, options, chrome)
        })
        .collect()
}

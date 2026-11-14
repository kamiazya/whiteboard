//! The answer of `layout_spatial_canvas`, as JSON text.

use whiteboard_canvas_render::compose_canvas::LaidOut;
use whiteboard_canvas_render::compose_node::Degradation;
use whiteboard_canvas_render::scene_wire::{Tree, scene_tree};
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_sides::EdgeAnchorPair;
use whiteboard_edge_routing::geometry::Point;

fn text(value: &str) -> Tree {
    Tree::Text(value.to_owned())
}

fn outcome(kind: &str, rest: Vec<Tree>) -> String {
    let mut items = vec![text(kind)];
    items.extend(rest);
    // Strings alone, which always have text.
    Tree::List(items).to_json().unwrap_or_default()
}

pub(super) fn refused(code: &str, class: &str) -> String {
    outcome("refused", vec![text(code), text(class)])
}

pub(super) fn declined(class: &str) -> String {
    outcome("declined", vec![text(class)])
}

const fn side_name(side: Side) -> &'static str {
    match side {
        Side::Top => "top",
        Side::Bottom => "bottom",
        Side::Left => "left",
        Side::Right => "right",
    }
}

fn point(p: Point) -> Tree {
    Tree::Object(vec![("x", Tree::Number(p.x)), ("y", Tree::Number(p.y))])
}

/// One anchor pair as the TypeScript's `EdgeAnchorPair`.
fn anchor(pair: &EdgeAnchorPair) -> Tree {
    let mut f = Vec::new();
    f.extend(pair.from.map(|p| ("from", point(p))));
    f.extend(pair.to.map(|p| ("to", point(p))));
    f.extend(pair.from_lane_depth.map(|d| ("fromLaneDepth", Tree::Number(d))));
    f.extend(pair.to_lane_depth.map(|d| ("toLaneDepth", Tree::Number(d))));
    f.extend(pair.from_side.map(|s| ("fromSide", text(side_name(s)))));
    f.extend(pair.to_side.map(|s| ("toSide", text(side_name(s)))));
    if pair.around {
        f.push(("around", Tree::Flag(true)));
    }
    Tree::Object(f)
}

/// One degradation as the TypeScript's `SpatialLayoutDegradation`.
fn event(event: &Degradation) -> Tree {
    let mut f = Vec::new();
    match event {
        Degradation::BodyParseFailed { node_id } => {
            f.extend([("kind", text("body-parse-failed")), ("nodeId", text(node_id))]);
        }
        Degradation::UnknownNodeKind { node_id, media_type } => f.extend([
            ("kind", text("unknown-node-kind")),
            ("nodeId", text(node_id)),
            ("type", text(media_type)),
        ]),
        Degradation::UnsupportedBackgroundStyle { node_id, style } => f.extend([
            ("kind", text("unsupported-background-style")),
            ("nodeId", text(node_id)),
            ("style", text(style.as_str())),
        ]),
        Degradation::UnknownTheme { theme } => {
            f.extend([("kind", text("unknown-theme")), ("theme", text(theme))]);
        }
        Degradation::FontMissing { family } => {
            f.extend([("kind", text("font-missing")), ("family", text(family))]);
        }
    }
    Tree::Object(f)
}

/// The layout as the `ok` answer, or declined when it holds a number JSON
/// cannot spell.
pub(super) fn laid_out(laid: &LaidOut, events: &[Degradation]) -> String {
    let anchors = laid.anchors.iter().map(|(id, pair)| Tree::List(vec![text(id), anchor(pair)]));
    let answer = Tree::List(vec![
        text("ok"),
        scene_tree(&laid.scene),
        Tree::List(anchors.collect()),
        Tree::List(events.iter().map(event).collect()),
    ]);
    answer.to_json().unwrap_or_else(|_| declined("non-finite"))
}

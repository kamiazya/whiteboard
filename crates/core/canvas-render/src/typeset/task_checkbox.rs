//! A task item's checkbox, ported from `task-checkbox.ts`: drawn from a rounded
//! rect and a tick rather than a glyph, since no font a measurer is handed is
//! guaranteed to hold one and the box has to be the size layout reserved.

use whiteboard_model::spatial::EdgeSide;
use whiteboard_scene::{
    Appearance, BoundingBox, EdgeEnd, ResolvedEdgeNode, SceneNode, ScenePoint, ShapeSceneNode,
    TaskBox,
};

use crate::theme::markdown::MarkdownTheme;

use super::options::body_line_height_px;

fn outline_paint(theme: &MarkdownTheme, opacity: f64) -> Appearance {
    Appearance {
        fill: Some("none".to_owned()),
        stroke: Some(theme.chrome_color.clone()),
        stroke_width: Some(theme.border_width_px),
        stroke_opacity: Some(opacity),
        ..Appearance::default()
    }
}

/// The marker nodes, wrapper-relative: the gutter left of the content is
/// negative x. A checked box adds its tick.
pub(super) fn checkbox_marker(
    theme: &MarkdownTheme,
    checked: bool,
    start_y: f64,
) -> Vec<SceneNode> {
    // `Math.round`: halves go up, which `f64::round` does not do for a negative.
    let size = (theme.body_font_size_px * 0.8 + 0.5).floor();
    let bbox = BoundingBox {
        x: -(size + theme.list_marker_gap_px),
        y: start_y + (body_line_height_px(theme) - size) / 2.0,
        w: size,
        h: size,
    };
    let frame = ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: None,
        bbox,
        comment_chrome: false,
        proposal_chrome: None,
        radius: Some((theme.corner_radius_px / 3.0).max(1.0)),
        shape: None,
        appearance: Some(outline_paint(theme, theme.border_opacity)),
        task_box: Some(TaskBox { checked }),
        ink: None,
    };
    let mut nodes = vec![SceneNode::Shape(Box::new(frame))];
    if checked {
        nodes.push(SceneNode::Edge(Box::new(tick(theme, bbox, size))));
    }
    nodes
}

fn tick(theme: &MarkdownTheme, box_: BoundingBox, size: f64) -> ResolvedEdgeNode {
    let at = |fx: f64, fy: f64| ScenePoint { x: box_.x + size * fx, y: box_.y + size * fy };
    ResolvedEdgeNode {
        id: "task-tick".to_owned(),
        jumps: None,
        path: vec![at(0.24, 0.52), at(0.43, 0.72), at(0.77, 0.3)],
        from_side: EdgeSide::Left,
        to_side: EdgeSide::Right,
        from_end: EdgeEnd::None,
        to_end: EdgeEnd::None,
        rounded: false,
        ink: None,
        comment_chrome: false,
        appearance: Some(Appearance {
            stroke: Some(theme.chrome_color.clone()),
            stroke_width: Some((theme.border_width_px * 1.5).max(1.5)),
            stroke_opacity: Some(theme.muted_text_opacity),
            ..Appearance::default()
        }),
    }
}

//! The frame: its chrome, tinted when it holds nothing, the picture behind its
//! members, and its caption above it.

use whiteboard_model::spatial::{BackgroundStyle, SpatialNode};
use whiteboard_scene::{BoundingBox, ImageFit, ImageSceneNode, SceneNode, ShapeSceneNode};

use super::{ComposeOptions, Degradation};
use crate::node_box::{LabelPlace, chrome_shape, label_of, label_runs};
use crate::node_content::{frame_background, frame_background_style};

/// Alpha of the stroke colour an empty frame is tinted with.
const EMPTY_FRAME_TINT_OPACITY: f64 = 0.06;

/// An empty frame filled faintly with its own stroke. A colour the author gave
/// the frame is already a fill, so only the unfilled default is tinted.
fn tint_empty(chrome: &mut ShapeSceneNode) {
    let Some(appearance) = chrome.appearance.as_mut() else { return };
    let Some(stroke) = appearance.stroke.clone() else { return };
    if appearance.fill.as_deref().is_none_or(|fill| fill == "none") {
        appearance.fill = Some(stroke);
        appearance.fill_opacity = Some(EMPTY_FRAME_TINT_OPACITY);
    }
}

/// A frame with no width or no height has nowhere to draw a picture.
fn has_area(node: &SpatialNode) -> bool {
    node.width > 0.0 && node.height > 0.0
}

/// The JSON Canvas group background: a picture over the whole frame, behind its
/// members. `ratio` fits it inside, anything else covers; `repeat` covers and is
/// reported. A reference that resolves to no picture keeps the plain frame.
fn group_background(node: &SpatialNode, options: &ComposeOptions<'_>) -> Option<SceneNode> {
    let background = frame_background(node)?;
    let image = options.layout.host.resolve_reference(background)?.image?;
    if !has_area(node) {
        return None;
    }
    let style = frame_background_style(node);
    if style == Some(BackgroundStyle::Repeat) {
        options.layout.host.degrade(Degradation::UnsupportedBackgroundStyle {
            node_id: node.id.clone(),
            style: BackgroundStyle::Repeat,
        });
    }
    let fit =
        if style == Some(BackgroundStyle::Ratio) { ImageFit::Contain } else { ImageFit::Cover };
    Some(SceneNode::Image(ImageSceneNode {
        bbox: BoundingBox { x: node.x, y: node.y, w: node.width, h: node.height },
        href: image.href,
        alt: image.alt,
        fit: Some(fit),
    }))
}

pub(super) fn compose_frame_node(
    node: &SpatialNode,
    options: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let mut chrome = chrome_shape(node, &options.node_box);
    if options.empty_frames.contains(&node.id) {
        tint_empty(&mut chrome);
    }
    let mut drawn = vec![SceneNode::Shape(Box::new(chrome))];
    drawn.extend(group_background(node, options));
    let label = label_of(node, None);
    drawn.extend(label_runs(node, label.as_deref(), LabelPlace::Above, &options.node_box));
    drawn
}

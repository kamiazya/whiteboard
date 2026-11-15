//! The layout options that are data already: the theme mode, the geometry,
//! the pinned edge sides, the tag library and the settled expansion policy.

use whiteboard_canvas_render::references::Expansion;
use whiteboard_canvas_render::theme::geometry::SpatialGeometry;
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_rules::SidePair;
use whiteboard_edge_routing::edge_sides::EdgeAnchorOverride;
use whiteboard_edge_routing::geometry::Point;
use whiteboard_model::Value;
use whiteboard_plugin_visual::visual::{TagKeyDeclaration, TagValueDeclaration};

use super::{entries_of, flag_of, strings_of};
use crate::json_canvas_wire::{Fields, number_of, string_of};

pub(super) fn dark_of(value: &Value) -> Option<bool> {
    match string_of(value)?.as_str() {
        "light" => Some(false),
        "dark" => Some(true),
        _ => None,
    }
}

pub(super) fn geometry_of(value: &Value) -> Option<SpatialGeometry> {
    let mut f = Fields::of(value)?;
    let geometry = SpatialGeometry {
        padding_px: f.field("paddingPx", number_of)??,
        label_font_size_px: f.field("labelFontSizePx", number_of)??,
        min_content_width_px: f.field("minContentWidthPx", number_of)??,
    };
    f.all_named().then_some(geometry)
}

fn side_of(value: &Value) -> Option<Side> {
    Some(match string_of(value)?.as_str() {
        "top" => Side::Top,
        "bottom" => Side::Bottom,
        "left" => Side::Left,
        "right" => Side::Right,
        _ => return None,
    })
}

fn point_of(value: &Value) -> Option<Point> {
    let mut f = Fields::of(value)?;
    let point = Point { x: f.field("x", number_of)??, y: f.field("y", number_of)?? };
    f.all_named().then_some(point)
}

pub(super) fn override_of(value: &Value) -> Option<EdgeAnchorOverride> {
    let mut f = Fields::of(value)?;
    let sides = SidePair {
        from_side: f.field("fromSide", side_of)??,
        to_side: f.field("toSide", side_of)??,
        around: f.field("around", flag_of)?.unwrap_or_default(),
    };
    let pin = EdgeAnchorOverride {
        sides,
        from: f.field("from", point_of)?,
        from_lane_depth: f.field("fromLaneDepth", number_of)?,
        to: f.field("to", point_of)?,
        to_lane_depth: f.field("toLaneDepth", number_of)?,
    };
    f.all_named().then_some(pin)
}

fn tag_value_of(value: &Value) -> Option<TagValueDeclaration> {
    let mut f = Fields::of(value)?;
    let declaration = TagValueDeclaration {
        color: f.field("color", string_of)?,
        description: f.field("description", string_of)?,
    };
    f.all_named().then_some(declaration)
}

pub(super) fn tag_key_of(value: &Value) -> Option<TagKeyDeclaration> {
    let mut f = Fields::of(value)?;
    let declaration = TagKeyDeclaration {
        description: f.field("description", string_of)?,
        exclusive: f.field("exclusive", flag_of)?,
        values: f.field("values", |v| entries_of(v, tag_value_of))?,
    };
    f.all_named().then_some(declaration)
}

/// `expand`: one answer for every file node, or the ids of the ones drawn open.
pub(super) fn expansion_of(value: &Value) -> Option<Expansion> {
    match value {
        Value::Bool(open) => Some(Expansion::Every(*open)),
        _ => strings_of(value).map(Expansion::Only),
    }
}

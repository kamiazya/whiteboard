//! A recorded canvas, read into the model: every double as the hex of its
//! bits, every facet bucket as plain JSON; the editor's frozen sides, the
//! anchors as the recordings write them, and the counting measurer.

use std::cell::Cell;

use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{FontDescriptor, Measure, VerticalMetrics};
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_rules::SidePair;
use whiteboard_edge_routing::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair};
use whiteboard_edge_routing::geometry::Point;
use whiteboard_model::spatial::{
    Arrowhead, BackgroundStyle, CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine,
    CanvasPoint, EdgeEnd, EdgeSide, LineEnd, LineEndNode, LineEndPoint, NodeResource,
    SpatialCanvas, SpatialNode,
};

use crate::facet_support::facets_of;

pub(crate) type Res<T> = Result<T, String>;

pub(crate) fn f64_of(hex: &str) -> Res<f64> {
    u64::from_str_radix(hex, 16).map(f64::from_bits).map_err(|e| format!("{hex}: {e}"))
}

pub(crate) fn hex(value: f64) -> String {
    let value = if value.is_nan() { f64::NAN } else { value };
    format!("{:016x}", value.to_bits())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ResourceWire {
    mime_type: String,
    content: Option<String>,
    location: Option<String>,
    subpath: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NodeWire {
    id: String,
    #[serde(rename = "box")]
    bbox: [String; 4],
    color: Option<String>,
    resource: Option<ResourceWire>,
    label: Option<String>,
    background: Option<String>,
    background_style: Option<String>,
    facets: Option<Value>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct EndWire {
    node: Option<String>,
    point: Option<[String; 2]>,
    side: Option<String>,
    end: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ElementWire {
    id: String,
    from: EndWire,
    to: EndWire,
    label: Option<String>,
    color: Option<String>,
    bends: Option<Vec<[String; 2]>>,
    facets: Option<Value>,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct OverrideWire {
    from_side: String,
    to_side: String,
    around: Option<bool>,
    from: Option<[String; 2]>,
    to: Option<[String; 2]>,
    from_lane_depth: Option<String>,
    to_lane_depth: Option<String>,
}

pub(crate) fn point_of(wire: &[String; 2]) -> Res<CanvasPoint> {
    Ok(CanvasPoint { x: f64_of(&wire[0])?, y: f64_of(&wire[1])? })
}

pub(crate) fn node_of(wire: &NodeWire) -> Res<SpatialNode> {
    let [x, y, w, h] = &wire.bbox;
    let background_style = match wire.background_style.as_deref() {
        None => None,
        Some(style) => {
            Some(BackgroundStyle::from_wire(style).ok_or(format!("background style {style}"))?)
        }
    };
    Ok(SpatialNode {
        id: wire.id.clone(),
        x: f64_of(x)?,
        y: f64_of(y)?,
        width: f64_of(w)?,
        height: f64_of(h)?,
        color: wire.color.as_deref().map(color_of),
        resource: wire.resource.as_ref().map(|r| NodeResource {
            mime_type: r.mime_type.clone(),
            content: r.content.clone(),
            location: r.location.clone(),
            subpath: r.subpath.clone(),
        }),
        label: wire.label.clone(),
        background: wire.background.clone(),
        background_style,
        facets: facets_of(wire.facets.as_ref()),
        tags: wire.tags.clone(),
        ..SpatialNode::default()
    })
}

pub(crate) fn marks_of(wire: &EndWire) -> Res<(Option<EdgeSide>, Option<Arrowhead>)> {
    let side = wire.side.as_deref().map(|s| EdgeSide::from_wire(s).ok_or(format!("side {s}")));
    let end = wire.end.as_deref().map(|e| Arrowhead::from_wire(e).ok_or(format!("end {e}")));
    Ok((side.transpose()?, end.transpose()?))
}

pub(crate) fn edge_end_of(wire: &EndWire) -> Res<EdgeEnd> {
    let (side, end) = marks_of(wire)?;
    let node = wire.node.clone().ok_or("an edge end names a node")?;
    Ok(EdgeEnd { node, side, end })
}

pub(crate) fn line_end_of(wire: &EndWire) -> Res<LineEnd> {
    let (side, end) = marks_of(wire)?;
    match (&wire.node, &wire.point) {
        (Some(node), None) => {
            Ok(LineEnd::LineEndNode(LineEndNode { node: node.clone(), side, end }))
        }
        (None, Some(point)) => {
            Ok(LineEnd::LineEndPoint(LineEndPoint { point: point_of(point)?, end }))
        }
        _ => Err("a line end is a node or a point".to_owned()),
    }
}

pub(crate) fn color_of(text: &str) -> CanvasColor {
    CanvasColorPreset::from_wire(text).map_or_else(
        || CanvasColor::CanvasColorHex(text.to_owned()),
        CanvasColor::CanvasColorPreset,
    )
}

pub(crate) fn bends_of(wire: &ElementWire) -> Res<Option<Vec<CanvasPoint>>> {
    wire.bends.as_ref().map(|bends| bends.iter().map(point_of).collect()).transpose()
}

pub(crate) fn edge_of(wire: &ElementWire) -> Res<CanvasEdge> {
    Ok(CanvasEdge {
        id: wire.id.clone(),
        from: edge_end_of(&wire.from)?,
        to: edge_end_of(&wire.to)?,
        color: wire.color.as_deref().map(color_of),
        label: wire.label.clone(),
        bends: bends_of(wire)?,
        facets: facets_of(wire.facets.as_ref()),
        tags: wire.tags.clone(),
    })
}

pub(crate) fn line_of(wire: &ElementWire) -> Res<CanvasLine> {
    Ok(CanvasLine {
        id: wire.id.clone(),
        from: line_end_of(&wire.from)?,
        to: line_end_of(&wire.to)?,
        color: wire.color.as_deref().map(color_of),
        label: wire.label.clone(),
        bends: bends_of(wire)?,
        facets: facets_of(wire.facets.as_ref()),
    })
}

/// A canvas from its recorded parts, with no board tags.
pub(crate) fn canvas_parts(
    facets: Option<&Value>,
    nodes: &[NodeWire],
    edges: &[ElementWire],
    lines: Option<&[ElementWire]>,
) -> Res<SpatialCanvas> {
    Ok(SpatialCanvas {
        nodes: nodes.iter().map(node_of).collect::<Res<_>>()?,
        edges: edges.iter().map(edge_of).collect::<Res<_>>()?,
        lines: lines.map(|lines| lines.iter().map(line_of).collect()).transpose()?,
        facets: facets_of(facets),
        tags: None,
    })
}

pub(crate) fn side_of(text: &str) -> Res<Side> {
    match text {
        "top" => Ok(Side::Top),
        "right" => Ok(Side::Right),
        "bottom" => Ok(Side::Bottom),
        "left" => Ok(Side::Left),
        other => Err(format!("side {other}")),
    }
}

pub(crate) fn pin_of(wire: &OverrideWire) -> Res<EdgeAnchorOverride> {
    let at = |p: &Option<[String; 2]>| {
        p.as_ref().map(|p| point_of(p).map(|c| Point { x: c.x, y: c.y })).transpose()
    };
    let depth = |d: &Option<String>| d.as_deref().map(f64_of).transpose();
    Ok(EdgeAnchorOverride {
        sides: SidePair {
            from_side: side_of(&wire.from_side)?,
            to_side: side_of(&wire.to_side)?,
            around: wire.around.unwrap_or(false),
        },
        from: at(&wire.from)?,
        from_lane_depth: depth(&wire.from_lane_depth)?,
        to: at(&wire.to)?,
        to_lane_depth: depth(&wire.to_lane_depth)?,
    })
}

/// The fake measurer, counting what it is asked.
pub(crate) struct Counting {
    pub(crate) base: FakeMeasure,
    pub(crate) calls: Cell<usize>,
}

impl Measure for Counting {
    fn advance_width(&self, text: &str, font: &FontDescriptor) -> f64 {
        self.calls.set(self.calls.get() + 1);
        self.base.advance_width(text, font)
    }

    fn vertical_metrics(&self, font: &FontDescriptor) -> VerticalMetrics {
        self.base.vertical_metrics(font)
    }
}

pub(crate) fn anchor_row(id: &str, pair: &EdgeAnchorPair) -> Vec<Option<String>> {
    let side = |s: Option<Side>| {
        s.map(|s| {
            match s {
                Side::Top => "top",
                Side::Right => "right",
                Side::Bottom => "bottom",
                Side::Left => "left",
            }
            .to_owned()
        })
    };
    let point = |p: Option<Point>| [p.map(|p| hex(p.x)), p.map(|p| hex(p.y))];
    let mut row = vec![Some(id.to_owned())];
    row.extend(point(pair.from));
    row.extend(point(pair.to));
    row.push(pair.from_lane_depth.map(hex));
    row.push(pair.to_lane_depth.map(hex));
    row.push(side(pair.from_side));
    row.push(side(pair.to_side));
    row.push(pair.around.then(|| "around".to_owned()));
    row
}

pub(crate) fn differ<T: PartialEq + std::fmt::Debug>(what: &str, got: &T, want: &T) -> Res<()> {
    if got == want { Ok(()) } else { Err(format!("{what}: got\n{got:?}\nrecorded\n{want:?}")) }
}

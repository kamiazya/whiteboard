//! `compose_edges_and_labels` against the recorded TypeScript answers
//! (`compose-edges.jsonl`): for each board under each theme and geometry, the
//! edges and lines drawn with their labels, the anchors the routing settled in
//! the order it settled them, and how many times the measurer was asked. What
//! the edge pass asks its host (the visual plugin's facets, the hops over the
//! routed edges) is answered from the recording.

#[path = "typeset_support/dump.rs"]
mod dump;
#[path = "theme_support/tokens.rs"]
mod tokens;

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use dump::dump_scene;
use serde::Deserialize;
use serde_json::Value;
use whiteboard_canvas_render::compose_edges::{
    EdgeFacets, EdgeJumps, EdgeOptions, compose_edges_and_labels,
};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::measure::{FontDescriptor, Measure, VerticalMetrics};
use whiteboard_canvas_render::node_box::{NodeBoxHost, NodeBoxOptions, TextPlacement};
use whiteboard_canvas_render::theme::appearance::{RoutableElement, SpatialAppearanceResolver};
use whiteboard_canvas_render::theme::asset::create_themed_appearance;
use whiteboard_canvas_render::theme::geometry::SpatialGeometry;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_edge_routing::edge_geometry::Side;
use whiteboard_edge_routing::edge_rules::SidePair;
use whiteboard_edge_routing::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair};
use whiteboard_edge_routing::geometry::Point;
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_model::spatial::{
    Arrowhead, CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine, CanvasPoint, EdgeEnd,
    EdgeSide, LineEnd, LineEndNode, LineEndPoint, NodeResource, SpatialCanvas, SpatialNode,
};
use whiteboard_plugin_visual::visual::{
    EdgeRoutingStyle, LineJumps, VisualEdgesFacet, VisualStrokeWidth,
};
use whiteboard_scene::{EdgeJumpPoint, ResolvedEdgeNode, Scene};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

type Res<T> = Result<T, String>;

fn f64_of(hex: &str) -> Res<f64> {
    u64::from_str_radix(hex, 16).map(f64::from_bits).map_err(|e| format!("{hex}: {e}"))
}

fn hex(value: f64) -> String {
    let value = if value.is_nan() { f64::NAN } else { value };
    format!("{:016x}", value.to_bits())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ResourceWire {
    mime_type: String,
    content: Option<String>,
    location: Option<String>,
    subpath: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeWire {
    id: String,
    #[serde(rename = "box")]
    bbox: [String; 4],
    resource: Option<ResourceWire>,
    label: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EndWire {
    node: Option<String>,
    point: Option<[String; 2]>,
    side: Option<String>,
    end: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ElementWire {
    id: String,
    from: EndWire,
    to: EndWire,
    label: Option<String>,
    color: Option<String>,
    bends: Option<Vec<[String; 2]>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct OverrideWire {
    from_side: String,
    to_side: String,
    around: Option<bool>,
    from: Option<[String; 2]>,
    to: Option<[String; 2]>,
    from_lane_depth: Option<String>,
    to_lane_depth: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StyleWire {
    style: Option<String>,
    routing: Option<String>,
    line_jumps: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Facts {
    canvas: StyleWire,
    own: Vec<StyleWire>,
    stroke: Vec<String>,
}

type JumpsWire = Vec<(String, Vec<[String; 3]>)>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    scene: String,
    anchors: Vec<Vec<Option<String>>>,
    jumps: Option<JumpsWire>,
    calls: usize,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    id: String,
    theme: String,
    geometry: [String; 3],
    nodes: Vec<NodeWire>,
    edges: Vec<ElementWire>,
    lines: Option<Vec<ElementWire>>,
    shapes: BTreeMap<String, String>,
    overrides: Option<Vec<(String, OverrideWire)>>,
    facts: Facts,
    answer: Answer,
}

fn point_of(wire: &[String; 2]) -> Res<CanvasPoint> {
    Ok(CanvasPoint { x: f64_of(&wire[0])?, y: f64_of(&wire[1])? })
}

fn node_of(wire: &NodeWire) -> Res<SpatialNode> {
    let [x, y, w, h] = &wire.bbox;
    Ok(SpatialNode {
        id: wire.id.clone(),
        x: f64_of(x)?,
        y: f64_of(y)?,
        width: f64_of(w)?,
        height: f64_of(h)?,
        resource: wire.resource.as_ref().map(|r| NodeResource {
            mime_type: r.mime_type.clone(),
            content: r.content.clone(),
            location: r.location.clone(),
            subpath: r.subpath.clone(),
        }),
        label: wire.label.clone(),
        ..SpatialNode::default()
    })
}

fn marks_of(wire: &EndWire) -> Res<(Option<EdgeSide>, Option<Arrowhead>)> {
    let side = wire.side.as_deref().map(|s| EdgeSide::from_wire(s).ok_or(format!("side {s}")));
    let end = wire.end.as_deref().map(|e| Arrowhead::from_wire(e).ok_or(format!("end {e}")));
    Ok((side.transpose()?, end.transpose()?))
}

fn edge_end_of(wire: &EndWire) -> Res<EdgeEnd> {
    let (side, end) = marks_of(wire)?;
    let node = wire.node.clone().ok_or("an edge end names a node")?;
    Ok(EdgeEnd { node, side, end })
}

fn line_end_of(wire: &EndWire) -> Res<LineEnd> {
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

fn color_of(text: &str) -> CanvasColor {
    CanvasColorPreset::from_wire(text).map_or_else(
        || CanvasColor::CanvasColorHex(text.to_owned()),
        CanvasColor::CanvasColorPreset,
    )
}

fn bends_of(wire: &ElementWire) -> Res<Option<Vec<CanvasPoint>>> {
    wire.bends.as_ref().map(|bends| bends.iter().map(point_of).collect()).transpose()
}

fn edge_of(wire: &ElementWire) -> Res<CanvasEdge> {
    Ok(CanvasEdge {
        id: wire.id.clone(),
        from: edge_end_of(&wire.from)?,
        to: edge_end_of(&wire.to)?,
        color: wire.color.as_deref().map(color_of),
        label: wire.label.clone(),
        bends: bends_of(wire)?,
        ..CanvasEdge::default()
    })
}

fn line_of(wire: &ElementWire) -> Res<CanvasLine> {
    Ok(CanvasLine {
        id: wire.id.clone(),
        from: line_end_of(&wire.from)?,
        to: line_end_of(&wire.to)?,
        color: wire.color.as_deref().map(color_of),
        label: wire.label.clone(),
        bends: bends_of(wire)?,
        facets: None,
    })
}

fn canvas_of(case: &Case) -> Res<SpatialCanvas> {
    Ok(SpatialCanvas {
        nodes: case.nodes.iter().map(node_of).collect::<Res<_>>()?,
        edges: case.edges.iter().map(edge_of).collect::<Res<_>>()?,
        lines: case.lines.as_ref().map(|lines| lines.iter().map(line_of).collect()).transpose()?,
        ..SpatialCanvas::default()
    })
}

fn side_of(text: &str) -> Res<Side> {
    match text {
        "top" => Ok(Side::Top),
        "right" => Ok(Side::Right),
        "bottom" => Ok(Side::Bottom),
        "left" => Ok(Side::Left),
        other => Err(format!("side {other}")),
    }
}

fn pin_of(wire: &OverrideWire) -> Res<EdgeAnchorOverride> {
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

fn style_of(wire: &StyleWire) -> Res<VisualEdgesFacet> {
    let routing = wire.style.as_deref().or(wire.routing.as_deref());
    let routing = routing.map(|r| EdgeRoutingStyle::from_wire(r).ok_or(format!("routing {r}")));
    let jumps =
        wire.line_jumps.as_deref().map(|j| LineJumps::from_wire(j).ok_or(format!("jumps {j}")));
    Ok(VisualEdgesFacet { routing: routing.transpose()?, line_jumps: jumps.transpose()? })
}

/// The fake measurer, counting what it is asked.
struct Counting {
    base: FakeMeasure,
    calls: Cell<usize>,
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

/// Every host answer of one case, from the case.
struct Host<'c> {
    case: &'c Case,
    canvas: &'c SpatialCanvas,
    jumps_asked: Cell<usize>,
    misses: RefCell<Vec<String>>,
}

impl Host<'_> {
    fn miss(&self, what: String) {
        self.misses.borrow_mut().push(what);
    }

    /// Where the element sits among the canvas's edges then lines, by identity.
    fn position(&self, element: RoutableElement<'_>) -> Option<usize> {
        match element {
            RoutableElement::Edge(edge) => {
                self.canvas.edges.iter().position(|e| std::ptr::eq(e, edge))
            }
            RoutableElement::Line(line) => {
                let lines = self.canvas.lines.as_deref().unwrap_or_default();
                lines
                    .iter()
                    .position(|l| std::ptr::eq(l, line))
                    .map(|at| at + self.canvas.edges.len())
            }
        }
    }
}

impl NodeBoxHost for Host<'_> {
    fn silhouette(&self, node_id: &str) -> Option<&str> {
        self.case.shapes.get(node_id).map(String::as_str)
    }

    fn text_placement(&self, _node: &SpatialNode) -> Option<TextPlacement> {
        None
    }
}

impl EdgeFacets for Host<'_> {
    fn canvas_style(&self, _canvas: &SpatialCanvas) -> VisualEdgesFacet {
        style_of(&self.case.facts.canvas).unwrap_or_else(|e| self.miss_with(e))
    }

    fn own_style(&self, element: RoutableElement<'_>) -> VisualEdgesFacet {
        match self.position(element).and_then(|at| self.case.facts.own.get(at)).map(style_of) {
            Some(Ok(style)) => style,
            Some(Err(e)) => self.miss_with(e),
            None => self.miss_with("an element the recording does not hold".to_owned()),
        }
    }

    fn stroke_width(&self, element: RoutableElement<'_>) -> Option<VisualStrokeWidth> {
        let wire = self.position(element).and_then(|at| self.case.facts.stroke.get(at));
        match wire.map(String::as_str) {
            Some("thin") => None,
            Some(width) => VisualStrokeWidth::from_wire(width),
            None => {
                self.miss("a weight the recording does not hold".to_owned());
                None
            }
        }
    }
}

impl Host<'_> {
    fn miss_with(&self, what: String) -> VisualEdgesFacet {
        self.miss(what);
        VisualEdgesFacet::default()
    }
}

impl EdgeJumps for Host<'_> {
    fn compute_edge_jumps(
        &self,
        _routed: &[ResolvedEdgeNode],
    ) -> Vec<(String, Vec<EdgeJumpPoint>)> {
        self.jumps_asked.set(self.jumps_asked.get() + 1);
        let Some(table) = &self.case.answer.jumps else {
            self.miss("hops nothing draws".to_owned());
            return Vec::new();
        };
        let point = |p: &[String; 3]| -> Res<EdgeJumpPoint> {
            Ok(EdgeJumpPoint { segment: f64_of(&p[0])?, x: f64_of(&p[1])?, y: f64_of(&p[2])? })
        };
        table
            .iter()
            .map(|(id, points)| Ok((id.clone(), points.iter().map(point).collect::<Res<_>>()?)))
            .collect::<Res<_>>()
            .unwrap_or_else(|e: String| {
                self.miss(e);
                Vec::new()
            })
    }
}

fn anchor_row(id: &str, pair: &EdgeAnchorPair) -> Vec<Option<String>> {
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

fn appearance_of(
    sketch: &ThemeTokens,
    neon: &ThemeTokens,
    theme: &str,
) -> Box<dyn SpatialAppearanceResolver> {
    match theme {
        "sketch" => Box::new(create_themed_appearance(sketch, SpatialThemeMode::Light, "Yomogi")),
        "neon" => Box::new(create_themed_appearance(neon, SpatialThemeMode::Light, "Roboto")),
        "dark" => Box::new(create_spatial_theme(SpatialThemeMode::Dark, None)),
        _ => Box::new(create_spatial_theme(SpatialThemeMode::Light, None)),
    }
}

fn geometry_of(case: &Case) -> Res<SpatialGeometry> {
    let [padding, label, floor] = &case.geometry;
    Ok(SpatialGeometry {
        padding_px: f64_of(padding)?,
        label_font_size_px: f64_of(label)?,
        min_content_width_px: f64_of(floor)?,
    })
}

fn differ<T: PartialEq + std::fmt::Debug>(what: &str, got: &T, want: &T) -> Res<()> {
    if got == want { Ok(()) } else { Err(format!("{what}: got\n{got:?}\nrecorded\n{want:?}")) }
}

fn replay_case(themes: &(ThemeTokens, ThemeTokens), case: &Case) -> Res<()> {
    let canvas = canvas_of(case)?;
    let host =
        Host { case, canvas: &canvas, jumps_asked: Cell::new(0), misses: RefCell::new(Vec::new()) };
    let measure = Counting { base: FakeMeasure::default(), calls: Cell::new(0) };
    let appearance = appearance_of(&themes.0, &themes.1, &case.theme);
    let theme = match case.theme.as_str() {
        "sketch" => Some(&themes.0),
        "neon" => Some(&themes.1),
        _ => None,
    };
    let pins: Option<Vec<(String, EdgeAnchorOverride)>> = case
        .overrides
        .as_ref()
        .map(|pins| pins.iter().map(|(id, pin)| Ok((id.clone(), pin_of(pin)?))).collect::<Res<_>>())
        .transpose()?;
    let options = EdgeOptions {
        node_box: NodeBoxOptions {
            measure: &measure,
            appearance: appearance.as_ref(),
            geometry: geometry_of(case)?,
            fit_to_box: true,
            theme,
            host: &host,
        },
        facets: &host,
        jumps: &host,
        side_overrides: pins.as_deref(),
    };
    let composed = compose_edges_and_labels(&canvas, &options);
    let scene = dump_scene(&Scene { nodes: composed.content, legend: None })?;
    if scene != case.answer.scene {
        return Err(format!("scene: got\n{scene}\nrecorded\n{}", case.answer.scene));
    }
    let anchors: Vec<_> = composed.anchors.iter().map(|(id, pair)| anchor_row(id, pair)).collect();
    differ("anchors", &anchors, &case.answer.anchors)?;
    differ("measurer calls", &measure.calls.get(), &case.answer.calls)?;
    differ("hops asked", &host.jumps_asked.get(), &usize::from(case.answer.jumps.is_some()))?;
    differ("host misses", &*host.misses.borrow(), &Vec::new())
}

fn themes_of(meta: &Value) -> Res<(ThemeTokens, ThemeTokens)> {
    let at = |key: &str| meta.get(key).ok_or(format!("the meta line's {key}"));
    Ok((tokens::theme_tokens(at("sketch")?)?, tokens::theme_tokens(at("neon")?)?))
}

/// A record's fields but its `kind`, which the reader has already dispatched on.
fn without_kind(record: &Value) -> Value {
    let mut fields = record.clone();
    if let Some(object) = fields.as_object_mut() {
        object.remove("kind");
    }
    fields
}

#[test]
fn every_recorded_edge_pass_is_reproduced_to_the_last_bit() {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/compose-edges.jsonl");
    let records: Vec<Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|e| panic!("a record: {e}")))
        .collect();
    let themes = themes_of(records.first().unwrap_or_else(|| panic!("a meta line")))
        .unwrap_or_else(|e| panic!("the meta line: {e}"));
    let mut failures = Vec::new();
    for (at, record) in records.iter().enumerate().skip(1) {
        let outcome = serde_json::from_value::<Case>(without_kind(record))
            .map_err(|e| e.to_string())
            .and_then(|case| replay_case(&themes, &case).map_err(|e| format!("{}: {e}", case.id)));
        if let Err(e) = outcome {
            failures.push(format!("line {}: {e}", at + 1));
        }
    }
    assert!(records.len() > 100, "{} records", records.len());
    assert!(
        failures.is_empty(),
        "{} differ, the first in full:\n{}\n{}",
        failures.len(),
        failures.first().map_or("", String::as_str),
        failures
            .iter()
            .map(|f| f.lines().next().unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n")
    );
}

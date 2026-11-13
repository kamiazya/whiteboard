//! The composer's edge pass (`composeEdgesAndLabels` in
//! `layout/spatial-canvas.ts`): every edge and line of a canvas routed in one
//! call, each weighed, inked and pulled onto the silhouettes of its ends, hops
//! put on the ones that draw them, and a label beside each that carries one.
//!
//! What this crate does not read yet is asked of the host: the visual plugin's
//! facets on the canvas and on each element ([`EdgeFacets`]), and the hops over
//! the routed edges ([`EdgeJumps`]).

mod label;
mod route;

use whiteboard_edge_routing::edge_router::{RoutedEdge, RoutingStyle};
use whiteboard_edge_routing::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair};
use whiteboard_edge_routing::routing_input::Arrowhead;
use whiteboard_facet_engine::engine::ThemeEdgeRouting;
use whiteboard_model::spatial::{CanvasEdge, CanvasLine, LineEnd, SpatialCanvas};
use whiteboard_plugin_visual::visual::{
    EdgeRoutingStyle, LineJumps, VisualEdgesFacet, VisualStrokeWidth,
};
use whiteboard_scene::{
    Annotates, AnnotatesKind, Appearance, BoundingBox, EdgeEnd, EdgeJumpPoint, ResolvedEdgeNode,
    SceneNode, ScenePoint, TextRunNode,
};

pub use label::{LabelSize, edge_label_placement, frame_title_boxes, label_obstacles};

use crate::measure::{FontDescriptor, FontStyle};
use crate::node_box::{NodeBoxOptions, js_trim, sketch_ink_for};
use crate::node_outline::outline_entry_point;
use crate::theme::appearance::RoutableElement;

/// The visual plugin's facets the edge pass reads.
pub trait EdgeFacets {
    /// The canvas's `visual.edges/v0`, what its edges default to.
    fn canvas_style(&self, canvas: &SpatialCanvas) -> VisualEdgesFacet;

    /// An element's own `visual.edges/v0`, narrowing the canvas's field by field.
    fn own_style(&self, element: RoutableElement<'_>) -> VisualEdgesFacet;

    /// An element's `visual.stroke/v0` weight; none is the thin weight.
    fn stroke_width(&self, element: RoutableElement<'_>) -> Option<VisualStrokeWidth>;
}

/// The hops of every crossing over the routed edges (`computeEdgeJumps`), by
/// edge id; asked only when some element draws them.
pub trait EdgeJumps {
    fn compute_edge_jumps(&self, routed: &[ResolvedEdgeNode]) -> Vec<(String, Vec<EdgeJumpPoint>)>;
}

/// What the edge pass is handed beside the canvas.
#[derive(Clone, Copy)]
pub struct EdgeOptions<'a> {
    pub node_box: NodeBoxOptions<'a>,
    pub facets: &'a dyn EdgeFacets,
    pub jumps: &'a dyn EdgeJumps,
    /// The editor's frozen sides, by element id.
    pub side_overrides: Option<&'a [(String, EdgeAnchorOverride)]>,
}

/// Every element drawn, then every label; and the anchors the routing settled.
#[derive(Debug, Clone, PartialEq)]
pub struct ComposedEdges {
    pub content: Vec<SceneNode>,
    pub anchors: Vec<(String, EdgeAnchorPair)>,
}

/// How many times the theme's line weight each named weight draws at: a
/// multiple, so a theme that draws heavier draws every weight heavier.
const fn stroke_factor(width: VisualStrokeWidth) -> f64 {
    match width {
        VisualStrokeWidth::Medium => 2.5,
        VisualStrokeWidth::Thick => 5.0,
    }
}

/// SVG's initial `stroke-width`, what an edge whose theme names no weight draws at.
const SVG_INITIAL_STROKE_WIDTH: f64 = 1.0;

/// The element's appearance with its own stroke weight applied. The thin weight
/// is the one every line had before weights existed, so it draws unchanged.
fn weigh_stroke(
    appearance: Option<Appearance>,
    width: Option<VisualStrokeWidth>,
) -> Option<Appearance> {
    let Some(width) = width else { return appearance };
    let base = appearance.as_ref().and_then(|a| a.stroke_width).unwrap_or(SVG_INITIAL_STROKE_WIDTH);
    Some(Appearance {
        stroke_width: Some(base * stroke_factor(width)),
        ..appearance.unwrap_or_default()
    })
}

const fn scene_end(end: Arrowhead) -> EdgeEnd {
    match end {
        Arrowhead::None => EdgeEnd::None,
        Arrowhead::Arrow => EdgeEnd::Arrow,
    }
}

fn resolved_edge(id: &str, routed: &RoutedEdge) -> ResolvedEdgeNode {
    ResolvedEdgeNode {
        id: id.to_owned(),
        jumps: None,
        path: routed.path.iter().map(|p| ScenePoint { x: p.x, y: p.y }).collect(),
        from_side: route::model_side(routed.from_side),
        to_side: route::model_side(routed.to_side),
        from_end: scene_end(routed.from_end),
        to_end: scene_end(routed.to_end),
        rounded: routed.rounded,
        ink: None,
        comment_chrome: false,
        appearance: None,
    }
}

/// The node an end of the element names; a free end of a line names none.
fn end_node(element: RoutableElement<'_>, to: bool) -> Option<&str> {
    fn line_end(end: &LineEnd) -> Option<&str> {
        match end {
            LineEnd::LineEndNode(on) => Some(on.node.as_str()),
            LineEnd::LineEndPoint(_) => None,
        }
    }
    match (element, to) {
        (RoutableElement::Edge(edge), false) => Some(edge.from.node.as_str()),
        (RoutableElement::Edge(edge), true) => Some(edge.to.node.as_str()),
        (RoutableElement::Line(line), false) => line_end(&line.from),
        (RoutableElement::Line(line), true) => line_end(&line.to),
    }
}

/// One end of the path pulled onto the silhouette of the node it attaches to:
/// the terminal moved inward along the segment it is approached by. A free end,
/// a node with no silhouette, and a pull that lands where the end already was
/// leave the path alone.
fn pull_end(
    path: &mut [ScenePoint],
    canvas: &SpatialCanvas,
    element: RoutableElement<'_>,
    to: bool,
    options: &EdgeOptions<'_>,
) {
    let Some(id) = end_node(element, to) else { return };
    let Some(shape) = options.node_box.host.silhouette(id) else { return };
    let Some(node) = canvas.nodes.iter().find(|node| node.id == id) else { return };
    let last = path.len().saturating_sub(1);
    let (at, inward) = if to { (last, last.checked_sub(1)) } else { (0, Some(1)) };
    let (Some(&terminal), Some(&inward)) = (path.get(at), inward.and_then(|i| path.get(i))) else {
        return;
    };
    let bbox = BoundingBox { x: node.x, y: node.y, w: node.width, h: node.height };
    let pulled = outline_entry_point(shape, &bbox, inward, terminal);
    if pulled == terminal {
        return;
    }
    if let Some(slot) = path.get_mut(at) {
        *slot = pulled;
    }
}

/// A routed element as drawn: its path's ends on their silhouettes (the router
/// reads boxes, so the pull comes after and routing is untouched by it), its
/// weight, and its ink. The arrival end is pulled first, the order the
/// recorded bytes were produced in: the entry search is iterative in floating
/// point.
fn compose_edge(
    canvas: &SpatialCanvas,
    element: RoutableElement<'_>,
    routed: &RoutedEdge,
    options: &EdgeOptions<'_>,
) -> ResolvedEdgeNode {
    let id = route::element_id(element);
    let mut edge = resolved_edge(id, routed);
    pull_end(&mut edge.path, canvas, element, true, options);
    pull_end(&mut edge.path, canvas, element, false, options);
    let appearance = options.node_box.appearance.resolve_edge(element);
    edge.appearance = weigh_stroke(appearance, options.facets.stroke_width(element));
    edge.ink = sketch_ink_for(id, &options.node_box, false);
    edge
}

const fn element_label(element: RoutableElement<'_>) -> Option<&String> {
    match element {
        RoutableElement::Edge(CanvasEdge { label, .. })
        | RoutableElement::Line(CanvasLine { label, .. }) => label.as_ref(),
    }
}

/// The label run of an element that carries a non-blank label, centred where
/// [`edge_label_placement`] puts it; none for a route that draws no line.
fn compose_edge_label(
    element: RoutableElement<'_>,
    routed: &ResolvedEdgeNode,
    options: &NodeBoxOptions<'_>,
    obstacles: &[BoundingBox],
) -> Option<TextRunNode> {
    let label = element_label(element).filter(|label| !js_trim(label).is_empty())?;
    let appearance = options.appearance.resolve_label();
    let size_px = options.geometry.label_font_size_px;
    let font = FontDescriptor {
        family: appearance.font_family.clone().unwrap_or_else(|| "sans-serif".to_owned()),
        fallback_chain: Vec::new(),
        weight: 400.0,
        style: FontStyle::Normal,
        size_px,
    };
    let metrics = options.measure.measure(label, &font);
    let size = LabelSize { w: metrics.advance_width, h: metrics.ascent + metrics.descent };
    let center = edge_label_placement(&routed.path, size, obstacles, routed.rounded)?;
    Some(TextRunNode {
        bbox: BoundingBox {
            x: center.x - size.w / 2.0,
            y: center.y - size.h / 2.0,
            w: size.w,
            h: size.h,
        },
        baseline: Some(metrics.ascent),
        text: label.clone(),
        appearance: Some(Appearance { font_size: Some(size_px), ..appearance }),
        annotates: Some(Annotates {
            kind: AnnotatesKind::Edge,
            id: route::element_id(element).to_owned(),
        }),
        ..crate::typeset::empty_run()
    })
}

const fn visual_routing(style: EdgeRoutingStyle) -> RoutingStyle {
    match style {
        EdgeRoutingStyle::Straight => RoutingStyle::Straight,
        EdgeRoutingStyle::Orthogonal => RoutingStyle::Orthogonal,
        EdgeRoutingStyle::Curved => RoutingStyle::Curved,
    }
}

const fn theme_routing(style: ThemeEdgeRouting) -> RoutingStyle {
    match style {
        ThemeEdgeRouting::Straight => RoutingStyle::Straight,
        ThemeEdgeRouting::Orthogonal => RoutingStyle::Orthogonal,
        ThemeEdgeRouting::Curved => RoutingStyle::Curved,
    }
}

/// Each element's own `visual.edges`, read once per id: a later element under
/// an id already read answers as the first did.
fn own_styles(elements: &[RoutableElement<'_>], facets: &dyn EdgeFacets) -> Vec<VisualEdgesFacet> {
    let mut seen: Vec<(&str, VisualEdgesFacet)> = Vec::new();
    elements
        .iter()
        .map(|&element| {
            let id = route::element_id(element);
            if let Some((_, style)) = seen.iter().find(|(known, _)| *known == id) {
                return style.clone();
            }
            let style = facets.own_style(element);
            seen.push((id, style.clone()));
            style
        })
        .collect()
}

/// The hops each element that draws them carries, when any does.
fn put_jumps(edges: &mut [ResolvedEdgeNode], hops: &[bool], jumps: &dyn EdgeJumps) {
    if !hops.contains(&true) {
        return;
    }
    let computed = jumps.compute_edge_jumps(edges);
    for (edge, hops) in edges.iter_mut().zip(hops) {
        if !hops {
            continue;
        }
        edge.jumps =
            computed.iter().find(|(id, _)| *id == edge.id).map(|(_, points)| points.clone());
    }
}

/// Every edge, then every line, of `canvas` drawn, then each one's label.
#[must_use]
pub fn compose_edges_and_labels(
    canvas: &SpatialCanvas,
    options: &EdgeOptions<'_>,
) -> ComposedEdges {
    let board = options.facets.canvas_style(canvas);
    // The theme's routing fills in only where the canvas's own facet is silent.
    let board_routing = board.routing.map(visual_routing).or_else(|| {
        options.node_box.theme.and_then(|tokens| tokens.defaults.edge_routing).map(theme_routing)
    });
    let elements: Vec<RoutableElement<'_>> = canvas
        .edges
        .iter()
        .map(RoutableElement::Edge)
        .chain(canvas.lines.iter().flatten().map(RoutableElement::Line))
        .collect();
    let own = own_styles(&elements, options.facets);
    let styles = own
        .iter()
        .map(|style| {
            style.routing.map(visual_routing).or(board_routing).unwrap_or(RoutingStyle::Straight)
        })
        .collect();
    let hops: Vec<bool> = own
        .iter()
        .map(|style| style.line_jumps.or(board.line_jumps) == Some(LineJumps::Arc))
        .collect();
    let titles = frame_title_boxes(&canvas.nodes, &options.node_box);
    let input = route::RouteInput {
        elements: &elements,
        styles,
        titles: &titles,
        overrides: options.side_overrides,
    };
    let (routes, anchors) = route::route(&canvas.nodes, &input);
    let mut drawn: Vec<ResolvedEdgeNode> = elements
        .iter()
        .zip(routes)
        .map(|(&element, routed)| compose_edge(canvas, element, &routed, options))
        .collect();
    put_jumps(&mut drawn, &hops, options.jumps);
    let obstacles = label_obstacles(&canvas.nodes, &titles);
    let labels: Vec<SceneNode> = elements
        .iter()
        .zip(&drawn)
        .filter_map(|(&element, edge)| {
            compose_edge_label(element, edge, &options.node_box, &obstacles)
        })
        .map(|run| SceneNode::TextRun(Box::new(run)))
        .collect();
    let mut content: Vec<SceneNode> =
        drawn.into_iter().map(|edge| SceneNode::Edge(Box::new(edge))).collect();
    content.extend(labels);
    ComposedEdges { content, anchors }
}

//! The composer's walk over a whole canvas (`layout/spatial-canvas.ts`):
//! [`layout_spatial_canvas`], the single canvas-to-scene builder every surface
//! shares, and its two side entries, [`layout_spatial_edges`] (the edge suffix
//! alone, for a live drag) and [`natural_node_content_size`] (how big a box has
//! to be).
//!
//! Each canvas is coloured by intent first, then settles its own theme and
//! silhouettes; every node is drawn in paint order with its decorations, then
//! every edge and line, then what the overlays draw over all of it. The
//! overlays (region outlines, comments, proposals and the legend) are a seam
//! until they are ported.

mod level;

use whiteboard_det::math::{compare_numbers, js_max};
use whiteboard_edge_routing::edge_sides::{EdgeAnchorOverride, EdgeAnchorPair};
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::frames::members_of;
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};
use whiteboard_plugin_visual::visual::TagLibrary;
use whiteboard_scene::{BoundingBox, NodeDecoration, Scene, SceneLegend, SceneNode};

use crate::compose_edges::{EdgeOptions, compose_edges_and_labels};
use crate::compose_node::{
    BodySeams, ComposeHost, ComposeOptions, ContentCache, compose_decorations, compose_node,
};
use crate::declared_colours::with_declared_colours;
use crate::measure::Measure;
use crate::node_content::is_frame;
use crate::scene_walk::SceneWalk;
use crate::theme::appearance::SpatialAppearanceResolver;
use crate::theme::geometry::SpatialGeometry;
use crate::typeset::NestedLayoutBudget;
pub use level::resolve_geometry;
use level::{Level, Place};

/// Which look a render draws (`SpatialRenderStyle`): `Clean` ignores any theme
/// a canvas names, `Document` draws the one it names, and a theme id draws that
/// theme unsaved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RenderStyle<'a> {
    #[default]
    Clean,
    Document,
    Theme(&'a str),
}

/// What the overlays draw over a laid-out canvas.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Overlaid {
    /// Drawn after everything the walk drew: region outlines, then comments,
    /// then proposals.
    pub nodes: Vec<SceneNode>,
    pub legend: Option<SceneLegend>,
}

/// The layers drawn over a canvas once its nodes and edges are: the comment
/// layer, the proposal layer and the legend.
pub trait Overlays {
    /// What is drawn over `canvas`, given what the walk drew of it (`drawn`, in
    /// paint order: every node, then every edge and label) and the options its
    /// nodes were composed with.
    fn overlay(
        &self,
        canvas: &SpatialCanvas,
        drawn: &[SceneNode],
        options: &ComposeOptions<'_>,
    ) -> Overlaid;
}

/// What a caller asks a layout for (`SpatialLayoutOptions`).
#[derive(Clone, Copy)]
pub struct LayoutOptions<'a> {
    pub measure: &'a dyn Measure,
    /// The appearance a canvas drawn in no theme is painted with; its mode
    /// picks a theme's palette, absence reading as light.
    pub appearance: &'a dyn SpatialAppearanceResolver,
    /// An override of the shared geometry, each field checked on its own.
    pub geometry: Option<SpatialGeometry>,
    pub style: RenderStyle<'a>,
    /// The themes a canvas or the style may name, by namespaced id.
    pub themes: &'a [(String, ThemeTokens)],
    /// Whether this surface holds a face for a family; absent, only the bundled one.
    pub font_available: Option<&'a dyn Fn(&str) -> bool>,
    pub registry: &'a Registry,
    /// What is drawn over each node after its own content, in order.
    pub decorations: &'a [&'a dyn NodeDecoration],
    /// The workspace's tag library, which colours by intent.
    pub tag_library: Option<&'a TagLibrary>,
    /// Nodes whose text the editor overlay owns.
    pub suppressed: &'a [String],
    /// Nodes the editor holds locked.
    pub locked: &'a [String],
    /// The editor's frozen sides, by element id.
    pub side_overrides: Option<&'a [(String, EdgeAnchorOverride)]>,
    pub host: &'a dyn ComposeHost,
    pub overlays: &'a dyn Overlays,
    pub content_cache: Option<&'a dyn ContentCache>,
    pub body: BodySeams<'a>,
    /// The nested-layout account this canvas spends from when it is itself
    /// embedded; absent, a fresh one.
    pub budget: Option<&'a NestedLayoutBudget>,
    /// The documents already being laid out around this canvas, outermost first.
    pub embed_path: &'a [String],
}

/// A laid-out canvas and the anchors its routing settled.
#[derive(Debug, Clone, PartialEq)]
pub struct LaidOut {
    pub scene: Scene,
    pub anchors: Vec<(String, EdgeAnchorPair)>,
}

/// The extent a node's content occupies when nothing is cut to fit it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ContentSize {
    pub w: f64,
    pub h: f64,
}

/// The order nodes are painted in (`paintOrderOf`): every frame first, a larger
/// before a smaller, then everything else in stored order. Stored order is a
/// map's id order, not the order an author wrote, so a frame listed after what
/// it holds would otherwise paint over it. Equal frames keep their order.
#[must_use]
pub fn paint_order_of(nodes: &[SpatialNode]) -> Vec<&SpatialNode> {
    let mut order: Vec<&SpatialNode> = nodes.iter().filter(|node| is_frame(node)).collect();
    order.sort_by(|a, b| compare_numbers(b.width * b.height, a.width * a.height));
    order.extend(nodes.iter().filter(|node| !is_frame(node)));
    order
}

/// The frames that hold nothing, tinted to read as a region.
fn empty_frame_ids(nodes: &[SpatialNode]) -> Vec<String> {
    nodes
        .iter()
        .filter(|node| is_frame(node) && members_of(nodes, node).next().is_none())
        .map(|node| node.id.clone())
        .collect()
}

/// One canvas laid out where `place` says, drawn in the theme it settles from
/// its own facets, else from `inherited`, the one it is embedded in.
fn walk(
    stored: &SpatialCanvas,
    options: &LayoutOptions<'_>,
    place: Place<'_>,
    inherited: Option<&str>,
) -> LaidOut {
    let canvas = with_declared_colours(stored, options.tag_library);
    let level = Level::of(&canvas, options, inherited);
    let empty_frames = empty_frame_ids(&canvas.nodes);
    let compose = level.compose(options, place, &empty_frames);
    let mut nodes: Vec<SceneNode> = paint_order_of(&canvas.nodes)
        .into_iter()
        .flat_map(|node| {
            let mut drawn = compose_node(node, &compose);
            drawn.extend(compose_decorations(node, &compose.node_box, options.decorations));
            drawn
        })
        .collect();
    let edges = compose_edges_and_labels(
        &canvas,
        &EdgeOptions { node_box: compose.node_box, side_overrides: options.side_overrides },
    );
    nodes.extend(edges.content);
    let overlaid = if place.annotated {
        options.overlays.overlay(&canvas, &nodes, &compose)
    } else {
        Overlaid::default()
    };
    nodes.extend(overlaid.nodes);
    LaidOut { scene: Scene { nodes, legend: overlaid.legend }, anchors: edges.anchors }
}

/// A canvas laid out (`layoutSpatialCanvasWithAnchors`): every node in paint
/// order with its decorations, every edge and line with its label, then the
/// overlays; and the anchors the routing settled, which a drag starts from.
#[must_use]
pub fn layout_spatial_canvas(stored: &SpatialCanvas, options: &LayoutOptions<'_>) -> LaidOut {
    let fresh = NestedLayoutBudget::new();
    let budget = options.budget.unwrap_or(&fresh);
    let place = Place { budget, embed_path: options.embed_path, fit_to_box: true, annotated: true };
    walk(stored, options, place, None)
}

/// A canvas embedded in the one `outer` composes, laid out at its own size on
/// `outer`'s path: no overlays, which belong to the canvas the caller asked for,
/// and a miniature draws no legend.
pub(crate) fn layout_nested_canvas(
    stored: &SpatialCanvas,
    outer: &ComposeOptions<'_>,
) -> Vec<SceneNode> {
    let place = Place {
        budget: outer.budget,
        embed_path: outer.embed_path,
        fit_to_box: true,
        annotated: false,
    };
    walk(stored, outer.layout, place, outer.theme_id).scene.nodes
}

/// The edge-and-label suffix of [`layout_spatial_canvas`]'s scene on its own
/// (`layoutSpatialEdges`), through the same colours and theme, for a caller that
/// already holds the node layer and moves only edges, as a live drag does.
#[must_use]
pub fn layout_spatial_edges(stored: &SpatialCanvas, options: &LayoutOptions<'_>) -> Vec<SceneNode> {
    let canvas = with_declared_colours(stored, options.tag_library);
    let level = Level::of(&canvas, options, None);
    let edge_options = EdgeOptions {
        node_box: level.node_box(options, true),
        side_overrides: options.side_overrides,
    };
    compose_edges_and_labels(&canvas, &edge_options).content
}

/// What of a node's drawing is content: not its chrome, and not a label drawn
/// above the box.
fn content_box<'s>(entry: &'s SceneNode, node: &SpatialNode) -> Option<&'s BoundingBox> {
    if matches!(entry, SceneNode::Shape(_)) {
        return None;
    }
    SceneWalk::Node(entry).bbox().filter(|bbox| bbox.y >= node.y)
}

/// How far a node's content reaches when nothing is cut to fit it
/// (`naturalNodeContentSize`): the question an auto-fit asks. A node needing
/// `h` of content is held by a height of `h` plus twice the padding. Laid out
/// as a canvas of its own, under the theme the style names.
#[must_use]
pub fn natural_node_content_size(node: &SpatialNode, options: &LayoutOptions<'_>) -> ContentSize {
    let single = SpatialCanvas { nodes: vec![node.clone()], ..SpatialCanvas::default() };
    let level = Level::of(&single, options, None);
    let fresh = NestedLayoutBudget::new();
    let budget = options.budget.unwrap_or(&fresh);
    let place = Place { budget, embed_path: &[], fit_to_box: false, annotated: false };
    let compose = level.compose(options, place, &[]);
    let drawn = compose_node(node, &compose);
    let boxes: Vec<&BoundingBox> =
        drawn.iter().filter_map(|entry| content_box(entry, node)).collect();
    if boxes.is_empty() {
        return ContentSize { w: 0.0, h: 0.0 };
    }
    let reach = |far: fn(&BoundingBox) -> f64| {
        boxes.iter().fold(f64::NEG_INFINITY, |most, bbox| js_max(most, far(bbox)))
    };
    let padding = resolve_geometry(options.geometry).padding_px;
    ContentSize {
        w: js_max(0.0, reach(|b| b.x + b.w) - (node.x + padding)),
        h: js_max(0.0, reach(|b| b.y + b.h) - (node.y + padding)),
    }
}

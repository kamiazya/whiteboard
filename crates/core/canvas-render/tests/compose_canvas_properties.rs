//! The live drag's parity, as a property: over any canvas, under any style and
//! with or without a tag library, the edges laid out alone
//! (`layout_spatial_edges`) are exactly the edge suffix of the whole layout
//! (`layout_spatial_canvas`), so a drag draws what the committed render draws.

#[path = "facet_support/mod.rs"]
mod facet_support;
#[path = "theme_support/tokens.rs"]
mod tokens;

use serde_json::Value;
use whiteboard_canvas_render::comments::CommentOptions;
use whiteboard_canvas_render::compose_canvas::{
    LayoutOptions, Overlays, RenderStyle, layout_spatial_canvas, layout_spatial_edges,
};
use whiteboard_canvas_render::compose_node::{
    BodySeams, ComposeHost, ComposeOptions, Degradation, ParseFailed,
};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::ResolvedReference;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::SpatialTheme;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_canvas_render::typeset::{IconRange, ImageRef, InlineSeams};
use whiteboard_facet_engine::engine::ThemeTokens;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_model::spatial::{CanvasEdge, EdgeEnd, NodeResource, SpatialCanvas, SpatialNode};
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_plugin_visual::render::StencilBadge;
use whiteboard_plugin_visual::visual::{TagKeyDeclaration, TagLibrary, TagValueDeclaration};
use whiteboard_proptest::proptest::prelude::{Strategy, any, prop, prop_assert_eq};
use whiteboard_proptest::{Floor, check};
use whiteboard_scene::{NodeDecoration, SceneLegend, SceneNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A host that reads every body as one paragraph and draws no overlay.
struct Plain;

impl ComposeHost for Plain {
    fn parse_body(&self, text: &str) -> Result<Root, ParseFailed> {
        let text = Phrasing::Text { value: text.to_owned() };
        Ok(Root { children: vec![Flow::Paragraph { children: vec![text] }] })
    }

    fn resolve_reference(&self, _: &str) -> Option<ResolvedReference> {
        None
    }

    fn expand_file_node(&self, _: &SpatialNode) -> bool {
        false
    }

    fn embedded_canvas(&self, _: &str, _: Option<&str>) -> Option<SpatialCanvas> {
        None
    }

    fn parse_markdown(&self, _: &str) -> Result<Root, ParseFailed> {
        Err(ParseFailed)
    }

    fn degrade(&self, _: Degradation) {}
}

impl InlineSeams for Plain {
    fn expand_emoji(&self, text: &str) -> String {
        text.to_owned()
    }

    fn icon_ranges(&self, _: &str) -> Vec<IconRange> {
        Vec::new()
    }

    fn document_title(&self, _: &str) -> Option<String> {
        None
    }

    fn embed_name(&self, _: &str) -> Option<String> {
        None
    }

    fn embed_pending(&self, _: &str) -> bool {
        false
    }

    fn image_reference(&self, _: &str) -> Option<ImageRef> {
        None
    }
}

impl Overlays for Plain {
    fn overlay(
        &self,
        _: &SpatialCanvas,
        _: &[SceneNode],
        _: &ComposeOptions<'_>,
    ) -> Option<SceneLegend> {
        None
    }
}

/// A facet bucket from JSON text.
fn facets(json: &str) -> Option<Vec<(String, whiteboard_model::Value)>> {
    let value: Value = serde_json::from_str(json).ok()?;
    facet_support::facets_of(Some(&value))
}

const SHAPES: [&str; 4] = [
    "",
    r#"{"visual.shape/v0":{"kind":"ellipse"}}"#,
    r#"{"visual.shape/v0":{"kind":"diamond"}}"#,
    r#"{"visual.stencil/v0":{"stencil":"visual.database"}}"#,
];
const EDGE_FACETS: [&str; 3] = [
    "",
    r#"{"visual.edges/v0":{"routing":"rounded","lineJumps":"arc"}}"#,
    r#"{"visual.stroke/v0":{"width":"thick"}}"#,
];
const CANVAS_FACETS: [&str; 4] = [
    "",
    r#"{"visual.theme/v0":{"theme":"visual.sketch"}}"#,
    r#"{"visual.theme/v0":{"theme":"visual.neon"},"visual.edges/v0":{"lineJumps":"arc"}}"#,
    r#"{"visual.edges/v0":{"routing":"orthogonal"}}"#,
];
const TAGS: [&str; 4] = ["health:failing", "health:ok", "team:core", "plain"];

fn pick<T: Copy>(items: &[T], at: usize) -> T {
    items[at % items.len()]
}

fn tags_of(mask: u8) -> Option<Vec<String>> {
    let tags: Vec<String> = TAGS
        .iter()
        .enumerate()
        .filter(|(i, _)| mask >> i & 1 == 1)
        .map(|(_, t)| (*t).to_owned())
        .collect();
    (!tags.is_empty()).then_some(tags)
}

/// One node: a text box or a frame, on a coarse grid so frames hold boxes.
fn node() -> impl Strategy<Value = (bool, u16, u16, u16, u16, usize, u8)> {
    (any::<bool>(), 0_u16..20, 0_u16..20, 1_u16..8, 1_u16..8, 0_usize..4, any::<u8>())
}

fn node_of(index: usize, drawn: (bool, u16, u16, u16, u16, usize, u8)) -> SpatialNode {
    let (frame, x, y, w, h, shape, tags) = drawn;
    SpatialNode {
        id: format!("n{index}"),
        x: f64::from(x) * 40.0,
        y: f64::from(y) * 40.0,
        width: f64::from(w) * 40.0,
        height: f64::from(h) * 30.0,
        resource: (!frame).then(|| NodeResource {
            mime_type: "text/markdown".to_owned(),
            content: Some(format!("box {index}")),
            location: None,
            subpath: None,
        }),
        facets: facets(pick(&SHAPES, shape)),
        tags: tags_of(tags),
        ..SpatialNode::default()
    }
}

fn edge_of(index: usize, nodes: usize, drawn: (usize, usize, bool, usize, u8)) -> CanvasEdge {
    let (from, to, label, style, tags) = drawn;
    let end = |at: usize| EdgeEnd { node: format!("n{}", at % nodes), side: None, end: None };
    CanvasEdge {
        id: format!("e{index}"),
        from: end(from),
        to: end(to),
        label: label.then(|| format!("edge {index}")),
        facets: facets(pick(&EDGE_FACETS, style)),
        tags: tags_of(tags),
        ..CanvasEdge::default()
    }
}

/// A canvas, the style it is laid out under, and whether the library is handed over.
fn board() -> impl Strategy<Value = (SpatialCanvas, usize, bool)> {
    let nodes = prop::collection::vec(node(), 1..6);
    let edges = prop::collection::vec(
        (0_usize..6, 0_usize..6, any::<bool>(), 0_usize..3, any::<u8>()),
        0..5,
    );
    (nodes, edges, 0_usize..4, 0_usize..4, any::<bool>()).prop_map(
        |(nodes, edges, canvas, style, library)| {
            let count = nodes.len();
            let canvas = SpatialCanvas {
                nodes: nodes.into_iter().enumerate().map(|(i, n)| node_of(i, n)).collect(),
                edges: edges.into_iter().enumerate().map(|(i, e)| edge_of(i, count, e)).collect(),
                facets: facets(pick(&CANVAS_FACETS, canvas)),
                ..SpatialCanvas::default()
            };
            (canvas, style, library)
        },
    )
}

/// Two keys, each colouring the values the generator draws.
fn library() -> TagLibrary {
    let key = |values: &[(&str, &str)]| TagKeyDeclaration {
        values: Some(
            values
                .iter()
                .map(|(value, color)| {
                    let declared = TagValueDeclaration {
                        color: Some((*color).to_owned()),
                        ..TagValueDeclaration::default()
                    };
                    ((*value).to_owned(), declared)
                })
                .collect(),
        ),
        ..TagKeyDeclaration::default()
    };
    vec![
        ("health".to_owned(), key(&[("failing", "1"), ("ok", "4")])),
        ("team".to_owned(), key(&[("core", "#12ab34")])),
    ]
}

/// The bundled themes and the test one, as the recording's meta line holds them.
fn themes() -> Result<Vec<(String, ThemeTokens)>, String> {
    let text = include_str!("../../../../packages/canvas-render/src/oracle/compose-canvas.jsonl");
    let meta: Value = serde_json::from_str(text.lines().next().unwrap_or_default())
        .map_err(|e| format!("the meta line: {e}"))?;
    let pairs = meta.get("themes").and_then(Value::as_array).ok_or("the meta line's themes")?;
    pairs
        .iter()
        .map(|pair| {
            let id = pair.get(0).and_then(Value::as_str).ok_or("a theme id")?;
            Ok((id.to_owned(), tokens::theme_tokens(pair.get(1).ok_or("a theme")?)?))
        })
        .collect()
}

const STYLES: [RenderStyle<'static>; 4] = [
    RenderStyle::Clean,
    RenderStyle::Document,
    RenderStyle::Theme("visual.neon"),
    RenderStyle::Theme("test.boxy"),
];

/// What every layout of the property shares.
struct Fixture {
    themes: Vec<(String, ThemeTokens)>,
    registry: Registry,
    declared: TagLibrary,
    measure: FakeMeasure,
    appearance: SpatialTheme,
}

fn options_of<'a>(
    fixture: &'a Fixture,
    decorations: &'a [&'a dyn NodeDecoration],
    style: RenderStyle<'a>,
    library: bool,
) -> LayoutOptions<'a> {
    LayoutOptions {
        measure: &fixture.measure,
        appearance: &fixture.appearance,
        geometry: None,
        style,
        themes: &fixture.themes,
        font_available: None,
        registry: &fixture.registry,
        decorations,
        tag_library: library.then_some(&fixture.declared),
        suppressed: &[],
        locked: &[],
        side_overrides: None,
        host: &Plain,
        overlays: &Plain,
        comments: CommentOptions::default(),
        proposals: &[],
        content_cache: None,
        body: BodySeams {
            inline: &Plain,
            highlight: None,
            math: None,
            diagram: None,
            embeds: None,
        },
        budget: None,
        embed_path: &[],
    }
}

/// Whether the library colours one of the canvas's edges.
fn colours_an_edge(canvas: &SpatialCanvas, library: bool) -> bool {
    library
        && canvas
            .edges
            .iter()
            .any(|e| e.tags.iter().flatten().any(|t| t == "health:ok" || t == "team:core"))
}

#[test]
fn the_edges_alone_are_the_whole_layouts_edge_suffix() {
    let fixture = Fixture {
        themes: themes().unwrap_or_else(|e| panic!("{e}")),
        registry: visual_registry().unwrap_or_else(|e| panic!("the bundled plugin: {e:?}")),
        declared: library(),
        measure: FakeMeasure::default(),
        appearance: create_spatial_theme(SpatialThemeMode::Light, None),
    };
    let badge = StencilBadge { registry: &fixture.registry };
    let decorations: [&dyn NodeDecoration; 1] = [&badge];
    let inked = Floor::new("a themed board with an edge");
    let coloured = Floor::new("an edge coloured by the library");
    check(board(), Some(64), |(canvas, style, library)| {
        let options = options_of(&fixture, &decorations, pick(&STYLES, style), library);
        let whole = layout_spatial_canvas(&canvas, &options).scene.nodes;
        let alone = layout_spatial_edges(&canvas, &options);
        let suffix = whole.get(whole.len() - alone.len()..).unwrap_or_default();
        inked.draw(alone.iter().any(|n| matches!(n, SceneNode::Edge(e) if e.ink.is_some())));
        coloured.draw(colours_an_edge(&canvas, library));
        prop_assert_eq!(alone.as_slice(), suffix);
        Ok(())
    });
    inked.assert(5);
    coloured.assert(5);
}

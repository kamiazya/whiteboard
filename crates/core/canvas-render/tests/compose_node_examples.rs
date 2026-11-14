//! What `compose-node.jsonl` does not reach: the recording draws no passage
//! highlights, since they are drawn only where the comment layer reaches.

use std::cell::Cell;

use whiteboard_canvas_render::comments::CommentOptions;
use whiteboard_canvas_render::compose_canvas::{LayoutOptions, RenderStyle};
use whiteboard_canvas_render::compose_node::{
    BodySeams, ComposeHost, ComposeOptions, Degradation, ParseFailed, compose_node,
};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::{NodeBoxOptions, NodeOutlines, ResolvedReference};
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::{SpatialTheme, create_spatial_theme};
use whiteboard_canvas_render::typeset::NestedLayoutBudget;
use whiteboard_canvas_render::typeset::{IconRange, ImageRef, InlineSeams};
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::annotation::{AnnotationAnchor, CommentThread};
use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_model::spatial::{NodeResource, SpatialCanvas, SpatialNode};
use whiteboard_model::text_anchor::{TextAnchor, TextQuote};
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_scene::SceneNode;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A host parsing a body as one paragraph, counting degradations.
#[derive(Default)]
struct Marking {
    degraded: Cell<usize>,
}

impl ComposeHost for Marking {
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

    fn degrade(&self, _: Degradation) {
        self.degraded.set(self.degraded.get() + 1);
    }
}

impl InlineSeams for Marking {
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

fn hello_at(x: f64, y: f64) -> SpatialNode {
    SpatialNode {
        id: "t".to_owned(),
        x,
        y,
        width: 160.0,
        height: 100.0,
        resource: Some(NodeResource {
            mime_type: "text/markdown".to_owned(),
            content: Some("Hello".to_owned()),
            location: None,
            subpath: None,
        }),
        ..SpatialNode::default()
    }
}

/// Each drawn node by what it is: a chrome by its id, the highlight, a paragraph.
fn kinds_of(drawn: &[SceneNode]) -> Vec<String> {
    drawn
        .iter()
        .map(|entry| match entry {
            SceneNode::Shape(shape) => shape.id.clone().unwrap_or_else(|| "mark".to_owned()),
            SceneNode::Paragraph(_) => "paragraph".to_owned(),
            other => format!("{other:?}"),
        })
        .collect()
}

/// A thread quoting `exact` in node `t`'s text.
fn quoting(exact: &str, resolved: bool) -> CommentThread {
    let quote = TextQuote { exact: exact.to_owned(), ..TextQuote::default() };
    CommentThread {
        id: "x".to_owned(),
        anchor: AnnotationAnchor::Text(TextAnchor {
            node_id: Some("t".to_owned()),
            quote,
            start: 1,
            end: 4,
        }),
        resolved,
        messages: Vec::new(),
    }
}

/// What `hello_composed` lays its node out under: the bundled light theme, no
/// overlays but the threads.
fn layout_of<'a>(
    measure: &'a FakeMeasure,
    appearance: &'a SpatialTheme,
    host: &'a Marking,
    registry: &'a Registry,
    threads: &'a [CommentThread],
) -> LayoutOptions<'a> {
    LayoutOptions {
        measure,
        appearance,
        geometry: None,
        style: RenderStyle::Clean,
        themes: &[],
        font_available: None,
        registry,
        decorations: &[],
        tag_library: None,
        suppressed: &[],
        locked: &[],
        side_overrides: None,
        host,
        comments: CommentOptions { threads, ..CommentOptions::default() },
        proposals: &[],
        content_cache: None,
        body: BodySeams { inline: host, highlight: None, math: None, diagram: None, embeds: None },
        budget: None,
        embed_path: &[],
    }
}

/// `hello_at(100, 50)` composed under `threads`, its passages drawn or not.
fn hello_composed(
    host: &Marking,
    registry: &Registry,
    threads: &[CommentThread],
    annotated: bool,
) -> Vec<SceneNode> {
    let measure = FakeMeasure::default();
    let appearance = create_spatial_theme(SpatialThemeMode::Light, None);
    let budget = NestedLayoutBudget::new();
    let layout = layout_of(&measure, &appearance, host, registry, threads);
    let options = ComposeOptions {
        node_box: NodeBoxOptions {
            measure: &measure,
            appearance: &appearance,
            geometry: SPATIAL_THEME_GEOMETRY,
            fit_to_box: true,
            theme: None,
            outlines: &NodeOutlines::default(),
            registry,
        },
        theme_id: None,
        layout: &layout,
        budget: &budget,
        embed_path: &[],
        embed_depth: 0,
        empty_frames: &[],
        annotated,
    };
    compose_node(&hello_at(100.0, 50.0), &options)
}

#[test]
fn passage_highlights_are_drawn_behind_the_body_and_placed_with_it() {
    let host = Marking::default();
    let registry = visual_registry().expect("the bundled plugin loads");
    let drawn = hello_composed(&host, &registry, &[quoting("ell", false)], true);
    let pad = SPATIAL_THEME_GEOMETRY.padding_px;
    let kinds = kinds_of(&drawn);
    assert_eq!(kinds, ["t", "x/passage-0", "paragraph"]);
    let Some(SceneNode::Shape(highlight)) = drawn.get(1) else { panic!("a highlight") };
    assert!(highlight.comment_chrome);
    assert!(highlight.bbox.x > 100.0 + pad && highlight.bbox.w > 0.0, "{:?}", highlight.bbox);
    assert!(highlight.appearance.is_some(), "painted as the theme's passage");
    assert_eq!(host.degraded.get(), 0, "nothing degrades here");
}

#[test]
fn a_settled_passage_is_drawn_only_with_the_settled_threads() {
    let host = Marking::default();
    let registry = visual_registry().expect("the bundled plugin loads");
    let drawn = hello_composed(&host, &registry, &[quoting("ell", true)], true);
    assert_eq!(kinds_of(&drawn), ["t", "paragraph"]);
}

#[test]
fn a_canvas_the_comment_layer_does_not_reach_draws_no_passage() {
    let host = Marking::default();
    let registry = visual_registry().expect("the bundled plugin loads");
    let threads = [quoting("ell", false)];
    assert_eq!(kinds_of(&hello_composed(&host, &registry, &threads, false)), ["t", "paragraph"]);
}

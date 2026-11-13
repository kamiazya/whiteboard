//! What `compose-node.jsonl` does not reach: the recording asks for no passage
//! highlights, since the comment layer that answers them is a host seam here.

use std::cell::Cell;

use whiteboard_canvas_render::compose_node::{
    BodySeams, ComposeHost, ComposeOptions, Degradation, ParseFailed, compose_node,
};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::{
    NodeBoxHost, NodeBoxOptions, ResolvedReference, TextPlacement,
};
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_canvas_render::typeset::NestedLayoutBudget;
use whiteboard_canvas_render::typeset::{FittedBlocks, IconRange, ImageRef, InlineSeams};
use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_model::spatial::{NodeResource, SpatialCanvas, SpatialNode};
use whiteboard_scene::{BoundingBox, SceneNode, ShapeSceneNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A host whose comment layer marks the body's origin, counting degradations.
#[derive(Default)]
struct Marking {
    degraded: Cell<usize>,
}

fn mark() -> SceneNode {
    SceneNode::Shape(Box::new(ShapeSceneNode {
        truncated: false,
        overflows: false,
        id: None,
        bbox: BoundingBox { x: 0.0, y: 0.0, w: 5.0, h: 5.0 },
        comment_chrome: false,
        proposal_chrome: None,
        radius: None,
        shape: None,
        appearance: None,
        task_box: None,
        ink: None,
    }))
}

impl NodeBoxHost for Marking {
    fn silhouette(&self, _: &str) -> Option<&str> {
        None
    }

    fn text_placement(&self, _: &SpatialNode) -> Option<TextPlacement> {
        None
    }
}

impl ComposeHost for Marking {
    fn parse_body(&self, text: &str) -> Result<Root, ParseFailed> {
        let text = Phrasing::Text { value: text.to_owned() };
        Ok(Root { children: vec![Flow::Paragraph { children: vec![text] }] })
    }

    fn resolve_reference(&self, _: &str) -> Option<ResolvedReference> {
        None
    }

    fn passage_highlights(&self, _: &SpatialNode, _: &str, body: &FittedBlocks) -> Vec<SceneNode> {
        assert_eq!(body.nodes.len(), 1, "the highlights are asked of the fitted body");
        vec![mark()]
    }

    fn expand_file_node(&self, _: &SpatialNode) -> bool {
        false
    }

    fn layout_nested_canvas(&self, _: &SpatialCanvas, _: &ComposeOptions<'_>) -> Vec<SceneNode> {
        Vec::new()
    }

    fn embedded_canvas(&self, _: &str, _: Option<&str>) -> Option<SpatialCanvas> {
        None
    }

    fn body_suppressed(&self, _: &str) -> bool {
        false
    }

    fn locked(&self, _: &str) -> bool {
        false
    }

    fn empty_frame(&self, _: &str) -> bool {
        false
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

#[test]
fn passage_highlights_are_drawn_behind_the_body_and_placed_with_it() {
    let measure = FakeMeasure::default();
    let appearance = create_spatial_theme(SpatialThemeMode::Light, None);
    let budget = NestedLayoutBudget::new();
    let host = Marking::default();
    let options = ComposeOptions {
        node_box: NodeBoxOptions {
            measure: &measure,
            appearance: &appearance,
            geometry: SPATIAL_THEME_GEOMETRY,
            fit_to_box: true,
            theme: None,
            host: &host,
        },
        theme_id: None,
        host: &host,
        content_cache: None,
        body: BodySeams { inline: &host, highlight: None, math: None, diagram: None, embeds: None },
        budget: &budget,
        embed_path: &[],
        embed_depth: 0,
    };
    let node = hello_at(100.0, 50.0);
    let drawn = compose_node(&node, &options);
    let pad = SPATIAL_THEME_GEOMETRY.padding_px;
    let kinds = kinds_of(&drawn);
    assert_eq!(kinds, ["t", "mark", "paragraph"]);
    let Some(SceneNode::Shape(highlight)) = drawn.get(1) else { panic!("a highlight") };
    assert_eq!(highlight.bbox, BoundingBox { x: 100.0 + pad, y: 50.0 + pad, w: 5.0, h: 5.0 });
    assert_eq!(host.degraded.get(), 0, "nothing degrades here");
}

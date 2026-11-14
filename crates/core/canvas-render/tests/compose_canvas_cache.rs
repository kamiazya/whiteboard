//! The content cache across nesting levels: a body that names a canvas is a
//! cycle on one embed path and drawn on another, and drawing it charges the
//! render's nested-layout account. A warm cache must change neither — the
//! scene is the one an uncached render draws.

use std::cell::RefCell;
use std::collections::BTreeMap;

use whiteboard_canvas_render::compose_canvas::{
    LayoutOptions, Overlaid, Overlays, RenderStyle, layout_spatial_canvas,
};
use whiteboard_canvas_render::compose_node::{
    BodySeams, ComposeHost, ComposeOptions, ContentCache, Degradation, ParseFailed,
};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::ResolvedReference;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_canvas_render::typeset::{
    CanvasSummary, EmbedResolver, Embedded, FittedBlocks, IconRange, ImageRef, InlineSeams,
    NestedLayoutBudget,
};
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_model::spatial::{NodeResource, SpatialCanvas, SpatialNode};
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_scene::SceneNode;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A node `id` at `x`, 260 by 200, of `resource`.
fn node(id: &str, x: f64, resource: NodeResource) -> SpatialNode {
    SpatialNode {
        id: id.to_owned(),
        x,
        y: 0.0,
        width: 260.0,
        height: 200.0,
        resource: Some(resource),
        ..SpatialNode::default()
    }
}

/// A text node; every body here reads as `![[X]]`, so every key is the same
/// unless the level is in it.
fn body(id: &str, x: f64) -> SpatialNode {
    let text = NodeResource {
        mime_type: "text/markdown".to_owned(),
        content: Some("X".to_owned()),
        ..NodeResource::default()
    };
    node(id, x, text)
}

/// The canvas every embed names: one body naming itself.
fn embedded() -> SpatialCanvas {
    SpatialCanvas { nodes: vec![body("inner", 0.0)], ..SpatialCanvas::default() }
}

/// A host for which every body is `![[X]]` and every reference is canvas `X`.
struct Naming;

impl ComposeHost for Naming {
    fn parse_body(&self, _: &str) -> Result<Root, ParseFailed> {
        let embed = Phrasing::Embed { document_id: "X".to_owned(), fragment: None };
        Ok(Root { children: vec![Flow::Paragraph { children: vec![embed] }] })
    }

    fn resolve_reference(&self, _: &str) -> Option<ResolvedReference> {
        Some(ResolvedReference { canvas: Some(embedded()), ..ResolvedReference::default() })
    }

    fn passage_highlights(&self, _: &SpatialNode, _: &str, _: &FittedBlocks) -> Vec<SceneNode> {
        Vec::new()
    }

    fn expand_file_node(&self, _: &SpatialNode) -> bool {
        true
    }

    fn embedded_canvas(&self, _: &str, _: Option<&str>) -> Option<SpatialCanvas> {
        Some(embedded())
    }

    fn degrade(&self, _: Degradation) {}
}

impl EmbedResolver for Naming {
    fn resolve_embed(&self, _: &str, _: Option<&str>) -> Option<Embedded> {
        let canvas = CanvasSummary { elements: 1, empty: false };
        Some(Embedded::Canvas { title: None, canvas: Some(canvas) })
    }
}

impl InlineSeams for Naming {
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

impl Overlays for Naming {
    fn overlay(&self, _: &SpatialCanvas, _: &[SceneNode], _: &ComposeOptions<'_>) -> Overlaid {
        Overlaid::default()
    }
}

/// A cache that keeps whatever it is handed.
#[derive(Default)]
struct Keeping(RefCell<BTreeMap<String, FittedBlocks>>);

impl ContentCache for Keeping {
    fn get(&self, key: &str) -> Option<FittedBlocks> {
        self.0.borrow().get(key).cloned()
    }

    fn set(&self, key: &str, body: &FittedBlocks) {
        self.0.borrow_mut().insert(key.to_owned(), body.clone());
    }
}

/// `canvas`'s scene, over a fresh `cache` when asked, with `layouts` nested
/// layouts left in the account, under the bundled plugin's `registry`.
fn scene_of(canvas: &SpatialCanvas, cached: bool, layouts: usize, registry: &Registry) -> String {
    let appearance = create_spatial_theme(SpatialThemeMode::Light, None);
    let cache = Keeping::default();
    let budget = NestedLayoutBudget::with_remaining(layouts, NestedLayoutBudget::ELEMENTS);
    let options = LayoutOptions {
        measure: &FakeMeasure::default(),
        appearance: &appearance,
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
        host: &Naming,
        overlays: &Naming,
        content_cache: cached.then_some(&cache as &dyn ContentCache),
        body: BodySeams {
            inline: &Naming,
            highlight: None,
            math: None,
            diagram: None,
            embeds: Some(&Naming),
        },
        budget: Some(&budget),
        embed_path: &[],
    };
    format!("{:?}", layout_spatial_canvas(canvas, &options).scene)
}

#[test]
fn a_body_cached_inside_an_embed_never_answers_the_same_body_at_the_top_level() {
    // The file node paints first and lays `X` out a level down, where the body
    // naming `X` is a cycle; at the top level the same body draws `X`.
    let file = NodeResource {
        mime_type: "application/json".to_owned(),
        location: Some("X".to_owned()),
        ..NodeResource::default()
    };
    let canvas = SpatialCanvas {
        nodes: vec![node("f", 0.0, file), body("t", 400.0)],
        ..SpatialCanvas::default()
    };
    let registry = visual_registry().expect("the bundled plugin loads");
    let layouts = NestedLayoutBudget::LAYOUTS;
    let cached = scene_of(&canvas, true, layouts, &registry);
    assert_eq!(cached, scene_of(&canvas, false, layouts, &registry));
}

#[test]
fn a_body_served_from_the_cache_still_leaves_its_embed_charged_to_the_render() {
    // One nested layout left: the first body spends it, so the second is refused.
    let canvas =
        SpatialCanvas { nodes: vec![body("a", 0.0), body("b", 400.0)], ..SpatialCanvas::default() };
    let registry = visual_registry().expect("the bundled plugin loads");
    let cached = scene_of(&canvas, true, 1, &registry);
    assert_eq!(cached.matches("Budget").count(), 1, "{cached}");
    assert_eq!(cached, scene_of(&canvas, false, 1, &registry));
}

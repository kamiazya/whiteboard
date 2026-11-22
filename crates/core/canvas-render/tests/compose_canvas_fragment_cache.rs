//! The content cache beside a fragment table (`fragmentTableReads`): the key
//! says whether the layout was given a table, so a body drawn without one is
//! never served to a layout whose table may replace its fallback, and a body
//! that asked a math or diagram renderer beside a table is not kept, since its
//! key cannot carry what the table answered.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use whiteboard_canvas_render::comments::CommentOptions;
use whiteboard_canvas_render::compose_canvas::{LayoutOptions, RenderStyle, layout_spatial_canvas};
use whiteboard_canvas_render::compose_node::{
    BodySeams, ComposeHost, ContentCache, Degradation, ParseFailed,
};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::ResolvedReference;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_canvas_render::typeset::{
    FittedBlocks, IconRange, ImageRef, InlineSeams, MathRenderer, Rendered,
};
use whiteboard_facet_engine::registry::Registry;
use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_model::spatial::{NodeResource, SpatialCanvas, SpatialNode};
use whiteboard_plugin_visual::host::visual_registry;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A text node `id` at `x`, 260 by 200, reading `text`.
fn body(id: &str, x: f64, text: &str) -> SpatialNode {
    let resource = NodeResource {
        mime_type: "text/markdown".to_owned(),
        content: Some(text.to_owned()),
        ..NodeResource::default()
    };
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

fn canvas(nodes: Vec<SpatialNode>) -> SpatialCanvas {
    SpatialCanvas { nodes, ..SpatialCanvas::default() }
}

/// A host for which a body starting `$$` is display math of the rest, and any
/// other body one paragraph of its text.
struct Mathy;

impl ComposeHost for Mathy {
    fn parse_body(&self, text: &str) -> Result<Root, ParseFailed> {
        let flow = match text.strip_prefix("$$") {
            Some(value) => Flow::Math { value: value.to_owned(), meta: None },
            None => Flow::Paragraph { children: vec![Phrasing::Text { value: text.to_owned() }] },
        };
        Ok(Root { children: vec![flow] })
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

    fn degrade(&self, _: Degradation) {}
}

impl InlineSeams for Mathy {
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

/// A math renderer counting every ask into `reads`, as a fragment table does,
/// and answering `svg` when it holds one.
struct Counting<'c> {
    reads: &'c Cell<usize>,
    svg: Option<&'static str>,
}

impl MathRenderer for Counting<'_> {
    fn render_math(&self, _: &str) -> Option<Rendered> {
        self.reads.set(self.reads.get() + 1);
        self.svg.map(|svg| Rendered::Markup(svg.to_owned()))
    }
}

/// A cache that keeps whatever it is handed and remembers what it was asked and kept.
#[derive(Default)]
struct Recording {
    asked: RefCell<Vec<String>>,
    kept: RefCell<Vec<String>>,
    entries: RefCell<BTreeMap<String, FittedBlocks>>,
}

impl ContentCache for Recording {
    fn get(&self, key: &str) -> Option<FittedBlocks> {
        self.asked.borrow_mut().push(key.to_owned());
        self.entries.borrow().get(key).cloned()
    }

    fn set(&self, key: &str, body: &FittedBlocks) {
        self.kept.borrow_mut().push(key.to_owned());
        self.entries.borrow_mut().insert(key.to_owned(), body.clone());
    }
}

/// How a layout is given its math: by a table (whose asks are counted) or not.
#[derive(Clone, Copy)]
enum Math {
    /// A renderer, but no table: its asks are not the cache's business.
    Seam,
    /// A table that holds nothing.
    EmptyTable,
    /// A table that holds every source.
    FullTable,
}

/// `canvas`'s scene, over `cache` when one is given.
fn scene_of(
    canvas: &SpatialCanvas,
    math: Math,
    cache: Option<&Recording>,
    registry: &Registry,
) -> String {
    let appearance = create_spatial_theme(SpatialThemeMode::Light, None);
    let reads = Cell::new(0);
    let svg = matches!(math, Math::FullTable).then_some("<svg/>");
    let renderer = Counting { reads: &reads, svg };
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
        host: &Mathy,
        content_cache: cache.map(|cache| cache as &dyn ContentCache),
        fragment_table_reads: (!matches!(math, Math::Seam)).then_some(&reads),
        comments: CommentOptions::default(),
        proposals: &[],
        body: BodySeams {
            inline: &Mathy,
            highlight: None,
            math: Some(&renderer),
            diagram: None,
            embeds: None,
        },
        budget: None,
        embed_path: &[],
    };
    format!("{:?}", layout_spatial_canvas(canvas, &options).scene)
}

#[test]
fn a_body_laid_out_beside_a_table_is_kept_under_a_key_that_says_so() {
    let registry = visual_registry().expect("the bundled plugin loads");
    let board = canvas(vec![body("a", 0.0, "plain")]);
    let without = Recording::default();
    scene_of(&board, Math::Seam, Some(&without), &registry);
    let beside = Recording::default();
    scene_of(&board, Math::EmptyTable, Some(&beside), &registry);
    // The key canvas-render's `contentCacheKey` builds for the same body.
    assert_eq!(*without.kept.borrow(), [r#"[260,200,"plain",null,"Roboto",null,[]]"#]);
    assert_eq!(*beside.kept.borrow(), [r#"[260,200,"plain",null,"Roboto",null,[],"fragments"]"#]);
}

#[test]
fn a_body_that_asked_the_table_is_never_kept() {
    let registry = visual_registry().expect("the bundled plugin loads");
    let board = canvas(vec![body("a", 0.0, "$$x"), body("b", 400.0, "plain")]);
    for math in [Math::EmptyTable, Math::FullTable] {
        let cache = Recording::default();
        scene_of(&board, math, Some(&cache), &registry);
        scene_of(&board, math, Some(&cache), &registry);
        let kept = cache.kept.borrow();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(kept.iter().all(|key| key.contains("plain")), "{kept:?}");
    }
}

#[test]
fn a_body_that_asked_a_seam_without_a_table_is_kept() {
    let registry = visual_registry().expect("the bundled plugin loads");
    let board = canvas(vec![body("a", 0.0, "$$x")]);
    let cache = Recording::default();
    let first = scene_of(&board, Math::Seam, Some(&cache), &registry);
    assert_eq!(cache.kept.borrow().len(), 1);
    assert_eq!(first, scene_of(&board, Math::Seam, Some(&cache), &registry));
    assert_eq!(cache.kept.borrow().len(), 1, "the second layout is a hit");
}

#[test]
fn a_body_kept_without_a_table_is_not_served_to_a_layout_with_one() {
    // The same cache: drawn first with the fallback, then given a table that
    // renders the math, the body must be laid out again, not served stale.
    let registry = visual_registry().expect("the bundled plugin loads");
    let board = canvas(vec![body("a", 0.0, "$$x")]);
    let cache = Recording::default();
    scene_of(&board, Math::Seam, Some(&cache), &registry);
    let warm = scene_of(&board, Math::FullTable, Some(&cache), &registry);
    assert_eq!(warm, scene_of(&board, Math::FullTable, None, &registry));
    assert_ne!(warm, scene_of(&board, Math::Seam, None, &registry));
}

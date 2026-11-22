//! A comment bubble's body resolves its `[[references]]` through the host
//! parse a text node's body takes, so a link in a bubble reads as it does in a
//! node and the two can never disagree about what counts as a reference.

use whiteboard_canvas_render::comments::CommentOptions;
use whiteboard_canvas_render::comments::body::{CommentDensity, layout_comment_body};
use whiteboard_canvas_render::compose_canvas::{LayoutOptions, RenderStyle};
use whiteboard_canvas_render::compose_node::{BodySeams, ComposeOptions};
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::{NodeBoxOptions, NodeOutlines};
use whiteboard_canvas_render::references::{LoadedReference, ReferenceWire, WireHost};
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::{SpatialTheme, create_spatial_theme};
use whiteboard_canvas_render::typeset::NestedLayoutBudget;
use whiteboard_facet_engine::registry::Registry;
use whiteboard_plugin_visual::host::visual_registry;
use whiteboard_scene::{LinkProvenance, SceneNode};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn wire() -> ReferenceWire {
    let page = LoadedReference {
        document_id: Some("D-PAGE".to_owned()),
        name: Some("Design page".to_owned()),
        ..LoadedReference::default()
    };
    ReferenceWire {
        entries: vec![("Some Page".to_owned(), Some(page))],
        titles: vec![("D-PAGE".to_owned(), "Design page".to_owned())],
        ..ReferenceWire::default()
    }
}

/// What a bubble body is laid out under: the measurer, theme and budget the
/// options borrow.
struct Parts {
    measure: FakeMeasure,
    appearance: SpatialTheme,
    budget: NestedLayoutBudget,
}

fn layout_options<'a>(
    parts: &'a Parts,
    registry: &'a Registry,
    host: &'a WireHost<'a>,
) -> LayoutOptions<'a> {
    LayoutOptions {
        measure: &parts.measure,
        appearance: &parts.appearance,
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
        comments: CommentOptions::default(),
        proposals: &[],
        content_cache: None,
        fragment_table_reads: None,
        body: BodySeams { inline: host, highlight: None, math: None, diagram: None, embeds: None },
        budget: None,
        embed_path: &[],
    }
}

/// The runs `text` draws as a bubble body under `host`, as `(label, link)`.
fn runs_of(
    host: &WireHost<'_>,
    registry: &Registry,
    text: &str,
) -> Vec<(String, Option<LinkProvenance>)> {
    let parts = Parts {
        measure: FakeMeasure::default(),
        appearance: create_spatial_theme(SpatialThemeMode::Light, None),
        budget: NestedLayoutBudget::new(),
    };
    let layout = layout_options(&parts, registry, host);
    let options = ComposeOptions {
        node_box: NodeBoxOptions {
            measure: &parts.measure,
            appearance: &parts.appearance,
            geometry: SPATIAL_THEME_GEOMETRY,
            fit_to_box: true,
            theme: None,
            outlines: &NodeOutlines::default(),
            registry,
        },
        theme_id: None,
        layout: &layout,
        budget: &parts.budget,
        embed_path: &[],
        embed_depth: 0,
        empty_frames: &[],
        annotated: false,
    };
    layout_comment_body("c", text, 400.0, CommentDensity::Comfortable, &options)
        .into_iter()
        .filter_map(|node| match node {
            SceneNode::Paragraph(block) => Some(block.runs),
            _ => None,
        })
        .flatten()
        .map(|run| (run.text, run.link))
        .collect()
}

#[test]
fn a_reference_in_a_bubble_body_draws_the_title_of_the_document_it_resolves_to() {
    let wire = wire();
    let host = WireHost::new(&wire, true);
    let registry = visual_registry().expect("the bundled registry");
    let runs = runs_of(&host, &registry, "See [[Some Page]] now");
    let link = runs.iter().find(|(_, link)| link.is_some()).expect("the reference is a link run");
    assert_eq!(link.0, "Design page");
    assert!(
        matches!(&link.1, Some(LinkProvenance::WikiLink { document_id, .. }) if document_id == "D-PAGE")
    );
}

#[test]
fn a_bubble_body_without_a_reference_draws_as_prose() {
    let wire = wire();
    let host = WireHost::new(&wire, true);
    let registry = visual_registry().expect("the bundled registry");
    let runs = runs_of(&host, &registry, "No links here");
    assert!(runs.iter().all(|(_, link)| link.is_none()));
    assert!(runs.iter().any(|(text, _)| text.contains("links")));
}

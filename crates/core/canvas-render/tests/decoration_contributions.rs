//! The decoration pass over contributions (`composeDecorations`): every
//! contribution is asked in order and what each answers is appended, each told
//! the node's content bounds and the label's appearance. The recording holds the
//! bundled plugin alone, so the order, the context and an empty list are here.

use whiteboard_canvas_render::compose_node::compose_decorations;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::node_box::{NodeBoxHost, NodeBoxOptions, TextPlacement};
use whiteboard_canvas_render::theme::appearance::SpatialAppearanceResolver;
use whiteboard_canvas_render::theme::geometry::SPATIAL_THEME_GEOMETRY;
use whiteboard_canvas_render::theme::mode::SpatialThemeMode;
use whiteboard_canvas_render::theme::spatial_theme::create_spatial_theme;
use whiteboard_model::spatial::SpatialNode;
use whiteboard_scene::{
    Appearance, BoundingBox, DecorationContext, IconSceneNode, NodeDecoration, SceneNode,
};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// Every node wears the diamond, whose inscribed box is its middle half.
struct Diamond;

impl NodeBoxHost for Diamond {
    fn silhouette(&self, _: &str) -> Option<&str> {
        Some("visual.diamond")
    }

    fn text_placement(&self, _: &SpatialNode) -> Option<TextPlacement> {
        None
    }
}

/// A contribution that draws one icon per name, over the bounds it is told and
/// in the label's appearance, and only on the node it is about.
struct Marks {
    node_id: &'static str,
    names: &'static [&'static str],
}

impl NodeDecoration for Marks {
    fn decorate(&self, node: &SpatialNode, context: &DecorationContext) -> Vec<SceneNode> {
        if node.id != self.node_id {
            return Vec::new();
        }
        let icon = |name: &&str| {
            SceneNode::Icon(IconSceneNode {
                bbox: context.bounds,
                icon: (*name).to_owned(),
                appearance: Some(context.label.clone()),
            })
        };
        self.names.iter().map(icon).collect()
    }
}

fn node() -> SpatialNode {
    SpatialNode {
        id: "n".to_owned(),
        x: 100.0,
        y: 40.0,
        width: 160.0,
        height: 80.0,
        ..SpatialNode::default()
    }
}

fn names(drawn: &[SceneNode]) -> Vec<&str> {
    drawn
        .iter()
        .map(|entry| match entry {
            SceneNode::Icon(icon) => icon.icon.as_str(),
            _ => "other",
        })
        .collect()
}

fn options<'a>(
    measure: &'a FakeMeasure,
    appearance: &'a dyn SpatialAppearanceResolver,
    fit_to_box: bool,
) -> NodeBoxOptions<'a> {
    NodeBoxOptions {
        measure,
        appearance,
        geometry: SPATIAL_THEME_GEOMETRY,
        fit_to_box,
        theme: None,
        host: &Diamond,
    }
}

#[test]
fn every_contribution_is_asked_in_order_and_its_marks_appended() {
    let measure = FakeMeasure::default();
    let appearance = create_spatial_theme(SpatialThemeMode::Dark, None);
    let first = Marks { node_id: "n", names: &["a", "b"] };
    let elsewhere = Marks { node_id: "other", names: &["x"] };
    let second = Marks { node_id: "n", names: &["c"] };
    let contributions: [&dyn NodeDecoration; 3] = [&first, &elsewhere, &second];
    let drawn = compose_decorations(&node(), &options(&measure, &appearance, true), &contributions);
    assert_eq!(names(&drawn), ["a", "b", "c"]);
    let none = compose_decorations(&node(), &options(&measure, &appearance, true), &[]);
    assert!(none.is_empty(), "no contribution draws nothing");
}

#[test]
fn a_contribution_is_told_the_content_bounds_and_the_label_appearance() {
    let measure = FakeMeasure::default();
    let appearance = create_spatial_theme(SpatialThemeMode::Dark, None);
    let label: Appearance = appearance.resolve_label();
    assert!(label.fill.is_some(), "the dark label is inked, so the label is observable");
    let marks = Marks { node_id: "n", names: &["a"] };
    let told = |fit_to_box| {
        let drawn =
            compose_decorations(&node(), &options(&measure, &appearance, fit_to_box), &[&marks]);
        match drawn.first() {
            Some(SceneNode::Icon(icon)) => (icon.bbox, icon.appearance.clone()),
            other => panic!("one icon, got {other:?}"),
        }
    };
    let inscribed = BoundingBox { x: 140.0, y: 60.0, w: 80.0, h: 40.0 };
    assert_eq!(told(true), (inscribed, Some(label.clone())));
    let own = BoundingBox { x: 100.0, y: 40.0, w: 160.0, h: 80.0 };
    assert_eq!(told(false), (own, Some(label)));
}

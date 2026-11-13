//! `resolve_node_outlines` (`resolveNodeOutlines`): a node's own
//! `visual.shape/v0` composed under the plugin's namespace, else the theme's
//! default shape for anything but a frame, else nothing. Each expected table is
//! what the TypeScript composes for the same nodes; the reader itself is held to
//! `facet-read.jsonl` by plugin-visual's replay of it.

use whiteboard_canvas_render::node_box::{NodeOutlines, resolve_node_outlines};
use whiteboard_model::Value;
use whiteboard_model::spatial::{NodeResource, SpatialNode};
use whiteboard_plugin_visual::host::visual_registry;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A text node, wearing `kind` as its `visual.shape/v0` when one is given.
fn boxed(id: &str, kind: Option<Value>) -> SpatialNode {
    SpatialNode {
        id: id.to_owned(),
        resource: Some(NodeResource {
            mime_type: "text/markdown".to_owned(),
            ..NodeResource::default()
        }),
        facets: kind.map(|kind| {
            vec![("visual.shape/v0".to_owned(), Value::Map(vec![("kind".to_owned(), kind)]))]
        }),
        ..SpatialNode::default()
    }
}

fn shaped(id: &str, kind: &str) -> SpatialNode {
    boxed(id, Some(Value::String(kind.to_owned())))
}

/// A frame: a node with no resource.
fn frame(node: SpatialNode) -> SpatialNode {
    SpatialNode { resource: None, ..node }
}

fn table(entries: &[(&str, &str)]) -> NodeOutlines {
    NodeOutlines(
        entries.iter().map(|(id, shape)| ((*id).to_owned(), (*shape).to_owned())).collect(),
    )
}

#[test]
fn a_node_wears_its_own_silhouette_under_the_plugins_namespace() {
    let registry = visual_registry().expect("the bundled plugin loads");
    let nodes = [shaped("a", "ellipse"), boxed("b", None), shaped("c", "cylinder")];
    let outlines = resolve_node_outlines(&nodes, &registry, None);
    assert_eq!(outlines, table(&[("a", "visual.ellipse"), ("c", "visual.cylinder")]));
}

#[test]
fn the_themes_default_fills_in_where_a_node_says_nothing_it_can_read() {
    let registry = visual_registry().expect("the bundled plugin loads");
    let nodes = [
        shaped("own", "diamond"),
        boxed("silent", None),
        shaped("unread", "star"),
        boxed("refused", Some(Value::Number(1.0))),
    ];
    let outlines = resolve_node_outlines(&nodes, &registry, Some("visual.octagon"));
    assert_eq!(
        outlines,
        table(&[
            ("own", "visual.diamond"),
            ("silent", "visual.octagon"),
            ("unread", "visual.octagon"),
            ("refused", "visual.octagon"),
        ])
    );
}

#[test]
fn a_frame_takes_no_default_but_keeps_its_own_silhouette() {
    let registry = visual_registry().expect("the bundled plugin loads");
    let nodes = [frame(boxed("plain", None)), frame(shaped("own", "hexagon"))];
    let outlines = resolve_node_outlines(&nodes, &registry, Some("visual.ellipse"));
    assert_eq!(outlines, table(&[("own", "visual.hexagon")]));
}

#[test]
fn a_default_naming_a_shape_nobody_carries_is_kept_as_named() {
    let registry = visual_registry().expect("the bundled plugin loads");
    let outlines = resolve_node_outlines(&[boxed("a", None)], &registry, Some("other.blob"));
    assert_eq!(outlines.of("a"), Some("other.blob"));
}

#[test]
fn a_later_node_under_an_id_answers_for_it_and_a_silent_one_does_not() {
    let registry = visual_registry().expect("the bundled plugin loads");
    let shaped_then_silent = [shaped("n", "ellipse"), boxed("n", None)];
    let outlines = resolve_node_outlines(&shaped_then_silent, &registry, None);
    assert_eq!(outlines.of("n"), Some("visual.ellipse"));
    let both = [shaped("n", "ellipse"), shaped("n", "diamond")];
    assert_eq!(resolve_node_outlines(&both, &registry, None).of("n"), Some("visual.diamond"));
    assert_eq!(resolve_node_outlines(&both, &registry, None).of("m"), None);
}

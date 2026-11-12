//! The embed block's rules, one example each: what a paragraph that is only an
//! embed becomes for every kind of target, and every way it degrades.

#[path = "typeset_support/examples.rs"]
mod examples;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_canvas_render::fake_measure::FakeMeasure;
use whiteboard_canvas_render::theme::markdown::MarkdownTheme;
use whiteboard_canvas_render::typeset::{
    CanvasMiniature, CanvasSummary, EmbedBox, EmbedResolver, Embedded, Miniature,
    NestedLayoutBudget, TypesetOptions, typeset_mdast_blocks,
};
use whiteboard_model::mdast::{Flow, Phrasing, Root};
use whiteboard_scene::{EmbedReason, Scene, SceneNode};

use examples::*;

/// Targets by id: a document, a canvas of some size, or nothing.
#[derive(Default)]
struct Targets {
    documents: Vec<(&'static str, Root)>,
    canvases: Vec<(&'static str, Option<CanvasSummary>)>,
}

impl EmbedResolver for Targets {
    fn resolve_embed(&self, id: &str, _fragment: Option<&str>) -> Option<Embedded> {
        if let Some((_, root)) = self.documents.iter().find(|(d, _)| *d == id) {
            return Some(Embedded::Document { title: Some(format!("T {id}")), root: root.clone() });
        }
        let (_, canvas) = self.canvases.iter().find(|(d, _)| *d == id)?;
        Some(Embedded::Canvas { title: None, canvas: *canvas })
    }
}

/// A picture of the box it is given, or none.
struct Picture(bool);

impl CanvasMiniature for Picture {
    fn miniature(
        &self,
        _: &str,
        _: Option<&str>,
        space: &EmbedBox,
        _: &[String],
    ) -> Option<Miniature> {
        self.0.then(|| Miniature { nodes: Vec::new(), w: space.max_width, h: 30.0 })
    }
}

fn embed(id: &str, fragment: Option<&str>) -> Flow {
    paragraph(vec![Phrasing::Embed {
        document_id: id.to_owned(),
        fragment: fragment.map(str::to_owned),
    }])
}

fn typeset(
    targets: Option<&Targets>,
    picture: Option<&Picture>,
    host: &Host,
    blocks: Vec<Flow>,
) -> Scene {
    let theme = MarkdownTheme::node();
    let measure = FakeMeasure::default();
    let options = TypesetOptions {
        embeds: targets.map(|t| t as &dyn EmbedResolver),
        canvas_layout: picture.map(|p| p as &dyn CanvasMiniature),
        ..TypesetOptions::new(&measure, 200.0, "sans-serif", &theme, host)
    };
    typeset_mdast_blocks(&Root { children: blocks }, &options)
}

fn doc(blocks: Vec<Flow>) -> Root {
    Root { children: blocks }
}

fn reason(node: &SceneNode) -> Option<EmbedReason> {
    match node {
        SceneNode::EmbedPlaceholder(p) => Some(p.reason),
        _ => None,
    }
}

#[test]
fn without_a_resolver_an_embed_paragraph_is_inline_prose() {
    let scene = typeset(None, None, &Host::default(), vec![embed("x", None)]);
    assert!(matches!(first(&scene), SceneNode::Paragraph(_)));
}

fn first(scene: &Scene) -> &SceneNode {
    &scene.nodes[0]
}

#[test]
fn a_target_nobody_holds_is_a_placeholder_labelled_with_its_address() {
    let targets = Targets::default();
    let scene = typeset(
        Some(&targets),
        None,
        &Host::default(),
        vec![embed("x", Some("Part")), embed("y", None)],
    );
    let SceneNode::EmbedPlaceholder(p) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!((p.title.as_str(), p.reason), ("x \u{203a} Part", EmbedReason::Unresolvable));
    same(p.bbox.h, 16.0);
    let SceneNode::EmbedPlaceholder(q) = &scene.nodes[1] else {
        panic!("scene node is not the expected variant")
    };
    same(q.bbox.y, 16.0 + 12.0);
}

#[test]
fn a_target_still_loading_is_a_framed_name_with_a_loading_line() {
    let host = Host { pending: true, title: Some("Listed"), ..Host::default() };
    let scene = typeset(Some(&Targets::default()), None, &host, vec![embed("x", None)]);
    let SceneNode::EmbedResolved(panel) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    same(panel.bbox.h, 16.0 + LINE + LINE + 16.0);
    assert!(matches!(&panel.children[0], SceneNode::Shape(_)));
    let SceneNode::TextRun(name) = &panel.children[1] else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(name.text, "Listed");
    let SceneNode::TextRun(loading) = &panel.children[2] else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(loading.text, "Loading\u{2026}");
}

#[test]
fn a_document_target_is_laid_out_in_place_and_a_fragment_narrows_it() {
    let h = |depth, title: &str| Flow::Heading { depth, children: vec![text(title)] };
    let body =
        doc(vec![h(2, "One"), paragraph(vec![text("a")]), h(2, "Two"), paragraph(vec![text("b")])]);
    let targets = Targets { documents: vec![("d", body)], ..Targets::default() };
    let whole = typeset(Some(&targets), None, &Host::default(), vec![embed("d", None)]);
    let SceneNode::EmbedResolved(all) = first(&whole) else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(all.children.len(), 4);
    let part = typeset(Some(&targets), None, &Host::default(), vec![embed("d", Some("two"))]);
    let SceneNode::EmbedResolved(some) = first(&part) else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(some.children.len(), 2);
    let none = typeset(Some(&targets), None, &Host::default(), vec![embed("d", Some("Nine"))]);
    let SceneNode::EmbedPlaceholder(p) = first(&none) else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(p.title, "T d \u{203a} Nine");
    assert_eq!(p.reason, EmbedReason::Unresolvable);
}

#[test]
fn an_embed_inside_itself_is_a_cycle_and_a_fourth_level_is_the_depth_cap() {
    let targets = Targets {
        documents: vec![
            ("a", doc(vec![embed("a", None)])),
            ("p", doc(vec![embed("q", None)])),
            ("q", doc(vec![embed("r", None)])),
            ("r", doc(vec![embed("s", None)])),
            ("s", doc(vec![paragraph(vec![text("end")])])),
        ],
        ..Targets::default()
    };
    let cycle = typeset(Some(&targets), None, &Host::default(), vec![embed("a", None)]);
    let SceneNode::EmbedResolved(outer) = first(&cycle) else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(reason(&outer.children[0]), Some(EmbedReason::Cycle));
    let chain = typeset(Some(&targets), None, &Host::default(), vec![embed("p", None)]);
    let mut node = first(&chain);
    let mut levels = 0;
    while let SceneNode::EmbedResolved(inner) = node {
        levels += 1;
        node = &inner.children[0];
    }
    assert_eq!(levels, 3);
    assert_eq!(reason(node), Some(EmbedReason::DepthCap));
}

#[test]
fn the_nested_layouts_one_render_may_spend_run_out() {
    let targets = Targets { documents: vec![("d", doc(Vec::new()))], ..Targets::default() };
    let blocks = (0..130).map(|_| embed("d", None)).collect();
    let scene = typeset(Some(&targets), None, &Host::default(), blocks);
    let spent = scene.nodes.iter().filter(|n| matches!(n, SceneNode::EmbedResolved(_))).count();
    assert_eq!(spent, NestedLayoutBudget::LAYOUTS);
    assert_eq!(reason(&scene.nodes[128]), Some(EmbedReason::Budget));
    assert_eq!(reason(&scene.nodes[129]), Some(EmbedReason::Budget));
}

#[test]
fn the_canvas_elements_one_render_may_nest_run_out() {
    let big = Some(CanvasSummary { elements: 2500, empty: false });
    let targets = Targets { canvases: vec![("c", big)], ..Targets::default() };
    let scene = typeset(
        Some(&targets),
        Some(&Picture(true)),
        &Host::default(),
        vec![embed("c", None), embed("c", None)],
    );
    assert!(matches!(first(&scene), SceneNode::EmbedResolved(_)));
    assert_eq!(reason(&scene.nodes[1]), Some(EmbedReason::Budget));
}

#[test]
fn a_canvas_target_is_a_panel_with_its_name_and_the_hosts_picture() {
    let some = Some(CanvasSummary { elements: 3, empty: false });
    let targets = Targets { canvases: vec![("c", some)], ..Targets::default() };
    let scene =
        typeset(Some(&targets), Some(&Picture(true)), &Host::default(), vec![embed("c", None)]);
    let SceneNode::EmbedResolved(panel) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    // padding, the name's line, padding, then the picture's 30px, padding.
    same(panel.bbox.h, 16.0 + LINE + 16.0 + 30.0 + 16.0);
    let unpictured =
        typeset(Some(&targets), Some(&Picture(false)), &Host::default(), vec![embed("c", None)]);
    let SceneNode::EmbedResolved(bare) = first(&unpictured) else {
        panic!("scene node is not the expected variant")
    };
    same(bare.bbox.h, 16.0 + LINE + 16.0);
}

#[test]
fn an_empty_canvas_says_so_and_one_the_fragment_misses_is_unresolvable() {
    let empty = Some(CanvasSummary { elements: 0, empty: true });
    let targets = Targets { canvases: vec![("e", empty), ("m", None)], ..Targets::default() };
    let scene = typeset(
        Some(&targets),
        Some(&Picture(true)),
        &Host::default(),
        vec![embed("e", None), embed("m", Some("x"))],
    );
    let SceneNode::EmbedResolved(panel) = first(&scene) else {
        panic!("scene node is not the expected variant")
    };
    let SceneNode::TextRun(notice) = &panel.children[2] else {
        panic!("scene node is not the expected variant")
    };
    assert_eq!(notice.text, "Empty canvas");
    assert_eq!(reason(&scene.nodes[1]), Some(EmbedReason::Unresolvable));
}

#[test]
fn a_canvas_with_no_host_picture_seam_is_unresolvable() {
    let some = Some(CanvasSummary { elements: 3, empty: false });
    let targets = Targets { canvases: vec![("c", some)], ..Targets::default() };
    let scene = typeset(Some(&targets), None, &Host::default(), vec![embed("c", None)]);
    assert_eq!(reason(first(&scene)), Some(EmbedReason::Unresolvable));
}

#[test]
fn the_element_account_may_be_spent_to_the_last_element() {
    let all = Some(CanvasSummary { elements: NestedLayoutBudget::ELEMENTS, empty: false });
    let one = Some(CanvasSummary { elements: 1, empty: false });
    let targets = Targets { canvases: vec![("all", all), ("one", one)], ..Targets::default() };
    let blocks = vec![embed("all", None), embed("one", None)];
    let scene = typeset(Some(&targets), Some(&Picture(true)), &Host::default(), blocks);
    assert!(matches!(first(&scene), SceneNode::EmbedResolved(_)));
    assert_eq!(reason(&scene.nodes[1]), Some(EmbedReason::Budget));
}

/// What the host is asked to draw, kept for the assertion.
struct Spy(std::cell::Cell<Option<f64>>);

impl CanvasMiniature for Spy {
    fn miniature(
        &self,
        _: &str,
        _: Option<&str>,
        space: &EmbedBox,
        _: &[String],
    ) -> Option<Miniature> {
        self.0.set(Some(space.max_width));
        None
    }
}

#[test]
fn a_canvas_in_a_column_that_is_not_a_number_is_drawn_in_a_box_that_is_not_one() {
    let some = Some(CanvasSummary { elements: 3, empty: false });
    let targets = Targets { canvases: vec![("c", some)], ..Targets::default() };
    let spy = Spy(std::cell::Cell::new(None));
    let theme = MarkdownTheme::node();
    let measure = FakeMeasure::default();
    let host = Host::default();
    let options = TypesetOptions {
        embeds: Some(&targets),
        canvas_layout: Some(&spy),
        ..TypesetOptions::new(&measure, f64::NAN, "sans-serif", &theme, &host)
    };
    let _scene = typeset_mdast_blocks(&Root { children: vec![embed("c", None)] }, &options);
    // `Math.max(0, NaN)` is NaN, so a clamp that answered 0 would hand the host a box the
    // column never described.
    assert!(spy.0.get().is_some_and(f64::is_nan));
}

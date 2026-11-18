//! The envelopes and forms a picture can be asked in besides the server's
//! (ADR-0054 A3.1): an explicit size, the legend left to the host, a view box
//! over the scene's bounds or its document bounds grown by a margin, the keyed
//! projection, and the `edges` query's and a comment's own pictures.

use serde_json::{Value as Json, json};
use whiteboard_canvas_render::scene_bounds::{scene_bounds, scene_document_bounds};
use whiteboard_canvas_render::svg::{
    KeyedSvgGroup, KeyedSvgRender, SvgDocumentOptions, render_scene_to_keyed_svg,
    render_scene_to_svg,
};
use whiteboard_model::spatial::{
    CanvasColor, CanvasColorPreset, CanvasEdge, EdgeEnd, SpatialCanvas,
};
use whiteboard_scene::{BoundingBox, Scene};

use super::answer::svg_item;
use super::request::ViewBox;
use super::svg_tests::{ask, markdown_answer, note, scene_of, svg_of};
use super::tests::{answer, board, fake, m, request, text_node};
use super::{MAX_SVG_BYTES, query_with_host};
use crate::json_canvas_wire::canvas_json;

fn drawn(scene: &Scene, options: &SvgDocumentOptions) -> String {
    render_scene_to_svg(scene, Some(options)).unwrap_or_default()
}

fn bounds_ask(of: &str, margin: Option<i64>) -> Json {
    let mut fields = vec![("of", json!(of))];
    fields.extend(margin.map(|m| ("margin", json!(m))));
    m(&[("viewBox", m(&fields))])
}

fn grown(b: BoundingBox, by: f64) -> BoundingBox {
    BoundingBox { x: b.x - by, y: b.y - by, w: b.w + by * 2.0, h: b.h + by * 2.0 }
}

#[test]
fn an_explicit_size_and_an_omitted_legend_reach_the_document() {
    let svg = m(&[("width", json!(321)), ("height", json!(123)), ("legend", json!("omit"))]);
    let got = answer(&request(board("hello"), &[("svg", svg)]));
    let scene = scene_of(&got);
    let options = SvgDocumentOptions {
        width: Some(321.0),
        height: Some(123.0),
        omit_legend: true,
        ..SvgDocumentOptions::default()
    };
    let expected = drawn(&scene, &options);
    assert!(expected.contains(r#"width="321" height="123""#), "{expected}");
    assert_eq!(svg_of(&got, 4), expected);
}

#[test]
fn a_bounds_view_box_is_the_scene_bounds_grown_by_its_margin() {
    let got = answer(&request(board("hello"), &[("svg", bounds_ask("scene", Some(16)))]));
    let scene = scene_of(&got);
    let view = grown(scene_bounds(&scene), 16.0);
    let expected =
        drawn(&scene, &SvgDocumentOptions { view_box: Some(view), ..Default::default() });
    assert_eq!(svg_of(&got, 4), expected);
    let document = answer(&request(board("hello"), &[("svg", bounds_ask("document", None))]));
    let view = scene_document_bounds(&scene_of(&document));
    let expected =
        drawn(&scene, &SvgDocumentOptions { view_box: Some(view), ..Default::default() });
    assert_eq!(svg_of(&document, 4), expected);
}

#[test]
fn a_margin_that_is_not_positive_grows_nothing() {
    let scene = scene_of(&answer(&request(board("hello"), &[])));
    let plain = svg_item(
        &scene,
        &ask(Some(ViewBox::Bounds { document: false, margin: None })),
        MAX_SVG_BYTES,
    );
    for margin in [0.0, -4.0, f64::NAN, f64::INFINITY] {
        let asked = ask(Some(ViewBox::Bounds { document: false, margin: Some(margin) }));
        assert_eq!(svg_item(&scene, &asked, MAX_SVG_BYTES), plain, "{margin}");
    }
}

#[test]
fn an_empty_scene_keeps_the_bounds_fallback_under_a_bounds_view_box() {
    let empty = canvas_json(&SpatialCanvas::default());
    let got = answer(&request(empty, &[("svg", bounds_ask("document", Some(16)))]));
    assert!(scene_of(&got).nodes.is_empty(), "{got}");
    assert_eq!(
        svg_of(&got, 4),
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="33" height="33" viewBox="-16 -16 33 33"></svg>"#
    );
}

#[test]
fn a_keyed_answer_is_the_projection_its_groups_make() {
    let svg = m(&[("viewBox", m(&[("of", json!("scene"))])), ("legend", json!("omit"))]);
    let keyed = m(&[
        ("viewBox", m(&[("of", json!("scene"))])),
        ("legend", json!("omit")),
        ("form", json!("keyed")),
    ]);
    let canvas = board("hello **world**");
    let plain = answer(&request(canvas.clone(), &[("svg", svg)]));
    let got = answer(&request(canvas, &[("svg", keyed)]));
    let scene = scene_of(&got);
    let options = SvgDocumentOptions {
        view_box: Some(scene_bounds(&scene)),
        omit_legend: true,
        ..SvgDocumentOptions::default()
    };
    let projection = render_scene_to_keyed_svg(&scene, Some(&options)).ok();
    let Some(projection) = projection else { panic!("no projection") };
    let root = got.pointer("/4/0").and_then(Json::as_str).unwrap_or_default();
    assert_eq!(root, projection.root_open);
    let attrs: Vec<(String, String)> =
        serde_json::from_value(got.pointer("/4/1").cloned().unwrap_or(Json::Null))
            .unwrap_or_default();
    assert_eq!(attrs, projection.root_attrs);
    let groups = got.pointer("/4/2").and_then(Json::as_array).cloned().unwrap_or_default();
    assert_eq!(groups.len(), projection.groups.len());
    assert!(!groups.is_empty());
    let joined: String =
        groups.iter().filter_map(|g| g.get(1).and_then(Json::as_str)).collect::<String>();
    // The projection's document is the root, the groups and the close, and
    // its root is the plain answer's.
    assert_eq!(format!("{root}{joined}</svg>"), projection.svg);
    assert!(svg_of(&plain, 4).starts_with(root), "{plain}");
}

#[test]
fn a_keyed_group_of_the_annotation_layer_is_flagged() {
    let group = |key: &str, annotation| KeyedSvgGroup {
        key: key.to_owned(),
        svg: format!("<g data-wb-key=\"{key}\"></g>"),
        annotation,
    };
    let keyed = KeyedSvgRender {
        svg: String::new(),
        root_open: "<svg>".to_owned(),
        root_attrs: vec![("xmlns".to_owned(), "x".to_owned())],
        groups: vec![group("a", false), group("c", true)],
    };
    let tree = super::answer::keyed_tree(keyed).to_json().unwrap_or_default();
    assert_eq!(
        tree,
        json!([
            "<svg>",
            [["xmlns", "x"]],
            [["a", "<g data-wb-key=\"a\"></g>"], ["c", "<g data-wb-key=\"c\"></g>", true]]
        ])
        .to_string()
    );
}

#[test]
fn a_keyed_answer_past_what_the_answer_carries_is_refused_whole() {
    let scene = scene_of(&answer(&request(board("hello"), &[])));
    let keyed = super::svg_tests::keyed_ask();
    let len = render_scene_to_keyed_svg(&scene, None).map(|k| k.svg.len()).unwrap_or_default();
    assert!(svg_item(&scene, &keyed, len).is_ok());
    let refused = json!(["refused", "input-too-large", "svg"]).to_string();
    assert_eq!(svg_item(&scene, &keyed, len - 1), Err(refused));
}

fn edges_query(svg: Option<Json>) -> Json {
    let a = text_node("a", "from");
    let mut b = text_node("b", "to");
    b.x = 400.0;
    let edge = CanvasEdge {
        id: "e".to_owned(),
        from: EdgeEnd { node: "a".to_owned(), ..EdgeEnd::default() },
        to: EdgeEnd { node: "b".to_owned(), ..EdgeEnd::default() },
        ..CanvasEdge::default()
    };
    let canvas = SpatialCanvas { nodes: vec![a, b], edges: vec![edge], ..SpatialCanvas::default() };
    let mut fields = vec![
        ("query", json!("edges")),
        ("canvas", canvas_json(&canvas)),
        ("measure", fake()),
        ("mode", json!("light")),
        ("expand", json!(false)),
    ];
    fields.extend(svg.map(|svg| ("svg", svg)));
    serde_json::from_str(&query_with_host(&m(&fields).to_string(), None)).unwrap_or(Json::Null)
}

#[test]
fn the_edges_query_answers_its_layer_drawn_as_a_scene_of_its_own() {
    let plain = edges_query(None);
    assert_eq!(plain.as_array().map(Vec::len), Some(3), "{plain}");
    let got = edges_query(Some(m(&[("viewBox", m(&[("of", json!("scene"))]))])));
    assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
    assert_eq!(got.get(1), plain.get(1));
    let layer: Scene = serde_json::from_value(json!({ "nodes": got.get(1) })).unwrap_or_default();
    assert!(!layer.nodes.is_empty(), "{got}");
    let view = scene_bounds(&layer);
    let expected =
        drawn(&layer, &SvgDocumentOptions { view_box: Some(view), ..Default::default() });
    assert!(expected.contains("<polyline"), "{expected}");
    assert_eq!(svg_of(&got, 3), expected);
    assert_eq!(got.as_array().map(Vec::len), Some(4));
}

#[test]
fn a_comment_answers_its_svg() {
    let comment = |svg: Option<Json>| {
        let mut fields = vec![
            ("kind", json!("comment")),
            ("body", json!("a **comment**")),
            ("maxWidth", json!(200)),
            ("measure", fake()),
            ("density", json!("compact")),
        ];
        fields.extend(svg.map(|svg| ("svg", svg)));
        markdown_answer(&m(&fields).to_string())
    };
    let got = comment(Some(m(&[("padding", json!(16))])));
    assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
    let scene = scene_of(&got);
    let expected = drawn(&scene, &SvgDocumentOptions { padding: Some(16.0), ..Default::default() });
    assert_eq!(svg_of(&got, 4), expected);
    assert_eq!(comment(None).as_array().map(Vec::len), Some(4));
}

#[test]
fn a_note_answers_its_keyed_projection() {
    let got =
        markdown_answer(&note(&[("svg", m(&[("padding", json!(16)), ("form", json!("keyed"))]))]));
    assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
    assert!(got.pointer("/4/2/0/0").and_then(Json::as_str).is_some(), "{got}");
}

#[test]
fn the_fuzz_seeds_asking_for_the_web_s_pictures_are_answered() {
    let keyed = |got: &Json| got.as_array().and_then(|a| a.last()).and_then(|k| k.get(2)).cloned();
    for seed in [
        include_str!("../../../../fuzz/seeds/layout_spatial_canvas_wasm/svg-keyed"),
        include_str!("../../../../fuzz/seeds/layout_spatial_canvas_wasm/markdown-comment-svg"),
    ] {
        let got = markdown_answer(seed);
        assert_eq!(got.get(0), Some(&json!("ok")), "{got}");
        assert!(
            keyed(&got).and_then(|g| g.as_array().map(Vec::len)).is_some_and(|n| n > 0),
            "{got}"
        );
    }
    let canvas = markdown_answer(include_str!(
        "../../../../fuzz/seeds/layout_spatial_canvas_wasm/svg-keyed"
    ));
    // The thread's pin is a group of the annotation layer.
    assert!(canvas.to_string().contains(",true]"), "{canvas}");
    let edges: Json = serde_json::from_str(&query_with_host(
        include_str!("../../../../fuzz/seeds/layout_query_wasm/edges-svg"),
        None,
    ))
    .unwrap_or(Json::Null);
    assert_eq!(edges.get(0), Some(&json!("ok")), "{edges}");
    assert!(
        svg_of(&edges, 3).starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" width="480""#),
        "{edges}"
    );
}

/** Two boxes coloured by a scoped tag's values: a board that draws a legend. */
fn legend_board() -> Json {
    let mut a = text_node("a", "red");
    a.color = Some(CanvasColor::CanvasColorPreset(CanvasColorPreset::V1));
    a.tags = Some(vec!["health:failing".to_owned()]);
    let mut b = text_node("b", "green");
    b.x = 240.0;
    b.color = Some(CanvasColor::CanvasColorPreset(CanvasColorPreset::V4));
    b.tags = Some(vec!["health:ok".to_owned()]);
    canvas_json(&SpatialCanvas { nodes: vec![a, b], ..SpatialCanvas::default() })
}

#[test]
fn an_omitted_legend_is_left_to_the_host() {
    let canvas = legend_board();
    let drawn_with = |legend: bool| {
        let mut svg = vec![("padding", json!(0))];
        if !legend {
            svg.push(("legend", json!("omit")));
        }
        answer(&request(canvas.clone(), &[("svg", m(&svg))]))
    };
    let (kept, omitted) = (drawn_with(true), drawn_with(false));
    let scene = scene_of(&kept);
    assert!(scene.legend.is_some(), "{kept}");
    let options = SvgDocumentOptions { padding: Some(0.0), ..SvgDocumentOptions::default() };
    assert_eq!(svg_of(&kept, 4), drawn(&scene, &options));
    let options = SvgDocumentOptions { omit_legend: true, ..options };
    assert_eq!(svg_of(&omitted, 4), drawn(&scene, &options));
    assert_ne!(svg_of(&kept, 4), svg_of(&omitted, 4));
}

#[test]
fn a_bounds_view_box_tells_the_scene_from_its_document() {
    let got = |of: &str| answer(&request(legend_board(), &[("svg", bounds_ask(of, None))]));
    let (scene_box, document_box) = (got("scene"), got("document"));
    let scene = scene_of(&scene_box);
    assert!(scene.legend.is_some(), "{scene_box}");
    let view = scene_bounds(&scene);
    let expected =
        drawn(&scene, &SvgDocumentOptions { view_box: Some(view), ..Default::default() });
    assert_eq!(svg_of(&scene_box, 4), expected);
    let view = scene_document_bounds(&scene);
    let expected =
        drawn(&scene, &SvgDocumentOptions { view_box: Some(view), ..Default::default() });
    assert_eq!(svg_of(&document_box, 4), expected);
    assert_ne!(svg_of(&scene_box, 4), svg_of(&document_box, 4));
    // A margin past every number grows nothing: the box stays the scene's own,
    // rather than the backend's derived one, which makes room for the legend.
    let plain = ask(Some(ViewBox::Bounds { document: false, margin: None }));
    let endless = ask(Some(ViewBox::Bounds { document: false, margin: Some(f64::INFINITY) }));
    assert_eq!(svg_item(&scene, &endless, MAX_SVG_BYTES), svg_item(&scene, &plain, MAX_SVG_BYTES));
}

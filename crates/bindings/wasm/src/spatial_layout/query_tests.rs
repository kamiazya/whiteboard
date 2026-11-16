use serde_json::{Value as Json, json};
use whiteboard_model::spatial::{SpatialCanvas, SpatialNode};

use std::cell::Cell;

use super::host_measure::Host;
use super::tests::{board, fake, m, s, text_node};
use super::{MAX_BODY_BYTES, MAX_ELEMENTS, MAX_FRAGMENTS, query_with_host};
use crate::input_caps::LAYOUT_QUERY;
use crate::json_canvas_wire::canvas_json;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

/// A host answering every text as ten units a character, counting the asks;
/// or, refusing, answering none.
#[derive(Default)]
struct Counting {
    asked: Cell<usize>,
    refuse: bool,
}

impl Host for Counting {
    fn measure(&self, text: &str, _: &str) -> Option<[f64; 4]> {
        self.asked.set(self.asked.get() + 1);
        let width = 10.0 * f64::from(u32::try_from(text.len()).unwrap_or(0));
        (!self.refuse).then_some([width, 8.0, 2.0, 0.0])
    }
}

fn ask(request: &Json) -> Json {
    serde_json::from_str(&query_with_host(&request.to_string(), None)).unwrap_or(Json::Null)
}

fn f(n: f64) -> Json {
    json!(["f", format!("{:016x}", n.to_bits())])
}

fn hex(n: f64) -> Json {
    json!(format!("{:016x}", n.to_bits()))
}

fn numbers(xs: &[f64]) -> Json {
    s(xs.iter().map(|&x| f(x)).collect())
}

fn refused(code: &str, class: &str) -> Json {
    json!(["refused", code, class])
}

fn node(id: &str, body: &str) -> Json {
    let wire = canvas_json(&SpatialCanvas {
        nodes: vec![text_node(id, body)],
        ..SpatialCanvas::default()
    });
    // The canvas wire's one node.
    wire.get(2).and_then(|nodes| nodes.get(1)).cloned().unwrap_or(Json::Null)
}

fn frame(id: &str) -> SpatialNode {
    SpatialNode { id: id.to_owned(), width: 300.0, height: 200.0, ..SpatialNode::default() }
}

fn size_request(body: &str, extra: &[(&str, Json)]) -> Json {
    let mut fields = vec![
        ("query", json!("node-size")),
        ("node", node("n", body)),
        ("measure", fake()),
        ("mode", json!("light")),
        ("floor", json!("ratio")),
    ];
    for (key, value) in extra {
        fields.retain(|(name, _)| name != key);
        fields.push((key, value.clone()));
    }
    m(&fields)
}

#[test]
fn an_input_that_is_not_a_query_is_refused() {
    let big = "x".repeat(LAYOUT_QUERY.max_bytes + 1);
    assert_eq!(query_with_host(&big, None), r#"["refused","input-too-large","too-large"]"#);
    assert_eq!(query_with_host("{", None), r#"["refused","malformed","wire"]"#);
    assert_eq!(ask(&m(&[("query", json!("nonesuch"))])), refused("malformed", "request"));
    assert_eq!(ask(&m(&[("box", numbers(&[0.0; 4]))])), refused("malformed", "request"));
    let extra = m(&[
        ("query", json!("outline-content-box")),
        ("box", numbers(&[0.0, 0.0, 10.0, 10.0])),
        ("stray", json!(true)),
    ]);
    assert_eq!(ask(&extra), refused("malformed", "request"));
    let short = m(&[("query", json!("outline-content-box")), ("box", numbers(&[0.0, 0.0, 10.0]))]);
    assert_eq!(ask(&short), refused("malformed", "request"));
}

#[test]
fn a_box_with_no_silhouette_is_its_own_content_box() {
    let asked =
        m(&[("query", json!("outline-content-box")), ("box", numbers(&[1.0, 2.0, 3.0, 4.0]))]);
    assert_eq!(ask(&asked), json!(["ok", [hex(1.0), hex(2.0), hex(3.0), hex(4.0)]]));
}

#[test]
fn a_path_that_draws_no_line_places_no_label_and_a_clear_one_sits_at_its_middle() {
    let place = |path: Vec<Json>| {
        ask(&m(&[
            ("query", json!("label-placement")),
            ("path", s(path)),
            ("size", numbers(&[10.0, 10.0])),
            ("obstacles", s(vec![])),
            ("rounded", json!(false)),
        ]))
    };
    assert_eq!(place(vec![numbers(&[5.0, 5.0])]), json!(["ok", []]));
    let line = place(vec![numbers(&[0.0, 0.0]), numbers(&[100.0, 0.0])]);
    assert_eq!(line, json!(["ok", [hex(50.0), hex(0.0)]]));
}

#[test]
fn only_a_run_annotating_a_frame_is_a_title() {
    let nodes = s(vec![
        canvas_json(&SpatialCanvas { nodes: vec![frame("F")], ..SpatialCanvas::default() })[2][1]
            .clone(),
        node("B", "box"),
    ]);
    let run = |kind: &str, id: &str, x: f64| {
        s(vec![json!(kind), json!(id), numbers(&[x, 0.0, 1.0, 1.0])])
    };
    let asked = m(&[
        ("query", json!("label-obstacles")),
        ("nodes", nodes),
        (
            "runs",
            s(vec![
                run("node", "F", 1.0),
                run("edge", "F", 2.0),
                run("node", "B", 3.0),
                run("node", "X", 4.0),
            ]),
        ),
    ]);
    let title = json!([hex(1.0), hex(0.0), hex(1.0), hex(1.0)]);
    let b = json!([hex(0.0), hex(0.0), hex(160.0), hex(80.0)]);
    assert_eq!(ask(&asked), json!(["ok", [title], [b, title]]));
    let bad = m(&[
        ("query", json!("label-obstacles")),
        ("nodes", s(vec![])),
        ("runs", s(vec![s(vec![json!("frame"), json!("F"), numbers(&[0.0; 4])])])),
    ]);
    assert_eq!(ask(&bad), refused("malformed", "request"));
}

#[test]
fn a_fitted_height_takes_the_taller_reading_unless_the_floor_is_declined() {
    let body = "words that wrap across the box when a wide face measures them";
    let narrow = m(&[("kind", json!("fake")), ("factor", f(0.2))]);
    let floored = ask(&size_request(body, &[("measure", narrow.clone())]));
    let own = ask(&size_request(body, &[("measure", narrow.clone()), ("floor", json!("none"))]));
    assert_ne!(floored, own, "the ratio measurer is the taller reading here");
    let natural = ask(&m(&[
        ("query", json!("node-content")),
        ("node", node("n", body)),
        ("measure", narrow),
        ("mode", json!("dark")),
    ]));
    let h = |answer: &Json, at: usize| {
        u64::from_str_radix(answer[1][at].as_str().unwrap_or_default(), 16).map(f64::from_bits)
    };
    // The fitted height is the content's plus the padding above and below it.
    assert_eq!(h(&own, 0).ok(), h(&natural, 1).ok().map(|content| content + 16.0));
    assert_eq!(
        ask(&size_request(body, &[("floor", json!("half"))])),
        refused("malformed", "request")
    );
}

#[test]
fn a_size_past_its_caps_is_refused_and_one_past_the_parser_bounds_is_sized_as_its_literal_text() {
    let long = "a".repeat(MAX_BODY_BYTES + 1);
    assert_eq!(ask(&size_request(&long, &[])), refused("input-too-large", "bodies"));
    let row = s(vec![
        json!("math:x"),
        m(&[("svg", json!("<g/>")), ("width", json!(1)), ("height", json!(1))]),
    ]);
    let table = s(vec![row; MAX_FRAGMENTS + 1]);
    let content = m(&[
        ("query", json!("node-content")),
        ("node", node("n", "x")),
        ("measure", fake()),
        ("mode", json!("light")),
        ("fragments", table),
    ]);
    assert_eq!(ask(&content), refused("input-too-large", "fragments"));
    let families = s((0..64).map(|i| json!(format!("F{i}"))).collect());
    let held = m(&[
        ("query", json!("node-content")),
        ("node", node("n", "x")),
        ("measure", fake()),
        ("mode", json!("light")),
        ("fontFamilies", families),
    ]);
    assert_eq!(ask(&held), refused("input-too-large", "font-families"));
    // A body past the parser's bounds is sized as the literal text it draws (D7a).
    let deep = format!("{}deep", "> ".repeat(40));
    assert_eq!(ask(&size_request(&deep, &[]))[0], json!("ok"));
    let fence = size_request("```ts\nconst x = 1\n```", &[]);
    assert_eq!(ask(&fence), json!(["needs", {"code": [["ts", "const x = 1"]]}]));
}

#[test]
fn a_host_measured_query_is_measured_by_the_host_or_refused() {
    let host_measure = m(&[("kind", json!("host"))]);
    let asked = size_request("hello", &[("measure", host_measure.clone())]);
    let text = asked.to_string();
    assert_eq!(query_with_host(&text, None), r#"["refused","malformed","host-measure"]"#);
    let refusing = Counting { refuse: true, ..Counting::default() };
    assert_eq!(
        query_with_host(&text, Some(&refusing)),
        r#"["refused","malformed","host-measure"]"#
    );
    let host = Counting::default();
    assert!(query_with_host(&text, Some(&host)).starts_with(r#"["ok",["#));
    assert!(host.asked.get() > 0, "the host measured the node's text");
}

fn edges(canvas: Json, extra: &[(&str, Json)]) -> Json {
    let mut fields = vec![
        ("query", json!("edges")),
        ("canvas", canvas),
        ("measure", fake()),
        ("mode", json!("light")),
        ("expand", json!(false)),
    ];
    fields.extend(extra.iter().cloned());
    m(&fields)
}

#[test]
fn an_edge_layer_past_the_canvas_caps_is_refused() {
    let many = SpatialCanvas {
        nodes: (0..=MAX_ELEMENTS).map(|i| text_node(&format!("n{i}"), "")).collect(),
        ..SpatialCanvas::default()
    };
    let past = edges(canvas_json(&many), &[]);
    assert_eq!(ask(&past), refused("input-too-large", "too-many-elements"));
    let none = ask(&edges(board("one box"), &[]));
    assert_eq!(none, json!(["ok", [], []]), "a canvas with no edge draws no edge layer");
    let stray = edges(board("x"), &[("floor", json!("ratio"))]);
    assert_eq!(ask(&stray), refused("malformed", "request"));
    let edge = whiteboard_model::spatial::CanvasEdge {
        id: "e".to_owned(),
        from: whiteboard_model::spatial::EdgeEnd { node: "a".to_owned(), ..Default::default() },
        to: whiteboard_model::spatial::EdgeEnd { node: "b".to_owned(), ..Default::default() },
        ..Default::default()
    };
    let far = SpatialCanvas {
        nodes: vec![
            whiteboard_model::spatial::SpatialNode { x: f64::INFINITY, ..text_node("a", "a") },
            text_node("b", "b"),
        ],
        edges: vec![edge],
        ..SpatialCanvas::default()
    };
    assert_eq!(ask(&edges(canvas_json(&far), &[])), refused("malformed", "non-finite"));
}

#[test]
fn label_obstacles_past_their_caps_are_refused() {
    let run = s(vec![json!("node"), json!("F"), numbers(&[0.0; 4])]);
    let at = |runs: usize, nodes: usize| {
        let box_node = node("B", "");
        ask(&m(&[
            ("query", json!("label-obstacles")),
            ("nodes", s(vec![box_node; nodes])),
            ("runs", s(vec![run.clone(); runs])),
        ]))
    };
    assert_eq!(at(super::MAX_RUNS + 1, 1), refused("input-too-large", "runs"));
    assert_eq!(at(1, MAX_ELEMENTS + 1), refused("input-too-large", "too-many-elements"));
    assert_eq!(at(super::MAX_RUNS, MAX_ELEMENTS)[0], json!("ok"));
}

#[test]
fn a_query_at_each_cap_is_read_and_one_past_it_refused() {
    // The byte cap: a text of exactly that length is read (and is no wire).
    let exact = "x".repeat(LAYOUT_QUERY.max_bytes);
    assert_eq!(query_with_host(&exact, None), r#"["refused","malformed","wire"]"#);
    // The runs a label-obstacles query may hand: four per element.
    let run = s(vec![json!("edge"), json!("e"), numbers(&[0.0; 4])]);
    let runs = |n: usize| {
        ask(&m(&[
            ("query", json!("label-obstacles")),
            ("nodes", s(vec![])),
            ("runs", s(vec![run.clone(); n])),
        ]))
    };
    assert_eq!(runs(4 * MAX_ELEMENTS)[0], json!("ok"));
    assert_eq!(runs(4 * MAX_ELEMENTS + 1), refused("input-too-large", "runs"));
    // A node's body at the bodies cap is read, past the parser's own bound
    // (sized as its literal text, D7a), and one at that bound and a table at
    // the fragment cap are laid out.
    let words = "ab ".repeat(MAX_BODY_BYTES / 3);
    assert_eq!(words.len(), MAX_BODY_BYTES);
    assert_eq!(ask(&size_request(&words, &[]))[0], json!("ok"));
    let parsed = "ab ".repeat(786_432 / 3);
    assert_eq!(ask(&size_request(&parsed, &[]))[0], json!("ok"));
    let row = s(vec![
        json!("math:x"),
        m(&[("svg", json!("<g/>")), ("width", json!(1)), ("height", json!(1))]),
    ]);
    let content = m(&[
        ("query", json!("node-content")),
        ("node", node("n", "x")),
        ("measure", fake()),
        ("mode", json!("light")),
        ("fragments", s(vec![row; MAX_FRAGMENTS])),
    ]);
    assert_eq!(ask(&content)[0], json!("ok"));
}

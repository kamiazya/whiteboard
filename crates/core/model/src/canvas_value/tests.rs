use super::{canvas_of, canvas_value};
use crate::Value;
use crate::json::parse;
use crate::spatial::{
    Arrowhead, BackgroundStyle, CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine,
    CanvasPoint, EdgeEnd, EdgeSide, LineEnd, LineEndNode, LineEndPoint, NodeEmbed, NodeResource,
    SpatialCanvas, SpatialNode,
};
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;

fn full_node() -> SpatialNode {
    SpatialNode {
        id: "a".into(),
        x: 1.0,
        y: -2.0,
        width: 3.5,
        height: 4.0,
        color: Some(CanvasColor::CanvasColorPreset(
            CanvasColorPreset::from_wire("3").unwrap_or_default(),
        )),
        embed: Some(NodeEmbed { document_id: "d".into(), version_ref: Some("v".into()) }),
        facets: Some(vec![("a.b/v1".into(), Value::Number(0.5))]),
        tags: Some(vec!["t".into()]),
        resource: Some(NodeResource {
            mime_type: "m".into(),
            content: Some("c".into()),
            location: Some("l".into()),
            subpath: Some("#s".into()),
        }),
        label: Some("L".into()),
        background: Some("b".into()),
        background_style: BackgroundStyle::from_wire("cover"),
    }
}

fn full() -> SpatialCanvas {
    let point = |x, y| CanvasPoint { x, y };
    let end = |node: &str| EdgeEnd {
        node: node.into(),
        side: EdgeSide::from_wire("left"),
        end: Arrowhead::from_wire("arrow"),
    };
    SpatialCanvas {
        nodes: vec![full_node()],
        edges: vec![CanvasEdge {
            id: "e".into(),
            from: end("a"),
            to: end("b"),
            color: Some(CanvasColor::CanvasColorHex("#ff0000".into())),
            label: Some("l".into()),
            bends: Some(vec![point(1.0, 2.5)]),
            facets: Some(vec![]),
            tags: Some(vec![]),
        }],
        lines: Some(vec![CanvasLine {
            id: "i".into(),
            from: LineEnd::LineEndNode(LineEndNode {
                node: "a".into(),
                side: EdgeSide::from_wire("top"),
                end: None,
            }),
            to: LineEnd::LineEndPoint(LineEndPoint {
                point: point(9.0, 8.0),
                end: Arrowhead::from_wire("none"),
            }),
            color: None,
            label: Some("x".into()),
            bends: Some(vec![]),
            facets: Some(vec![("k".into(), Value::Null)]),
        }]),
        facets: Some(vec![("c.d/v2".into(), Value::Bool(false))]),
        tags: Some(vec!["u".into()]),
    }
}

/// The value a JSON text holds, keys in written order.
fn value(text: &str) -> Value {
    parse(text).unwrap_or_else(|refused| panic!("{text}: {refused:?}"))
}

/// The keys of a map, in order.
fn keys(value: &Value) -> Vec<&str> {
    match value {
        Value::Map(entries) => entries.iter().map(|(key, _)| key.as_str()).collect(),
        _ => Vec::new(),
    }
}

fn member<'a>(value: &'a Value, name: &str) -> &'a Value {
    match value {
        Value::Map(entries) => {
            entries.iter().find(|(key, _)| key == name).map_or(&Value::Null, |(_, v)| v)
        }
        _ => &Value::Null,
    }
}

fn first(value: &Value) -> &Value {
    match value {
        Value::Seq(items) => items.first().unwrap_or(&Value::Null),
        _ => &Value::Null,
    }
}

#[test]
fn a_canvas_with_every_field_reads_back_as_itself() {
    let canvas = full();
    assert_eq!(canvas_of(&canvas_value(&canvas)), Some(canvas));
    let empty = SpatialCanvas::default();
    assert_eq!(canvas_value(&empty), value(r#"{"nodes":[],"edges":[]}"#));
    assert_eq!(canvas_of(&canvas_value(&empty)), Some(empty));
}

#[test]
fn each_object_is_written_in_the_order_the_typescript_lifts_it() {
    let written = canvas_value(&full());
    assert_eq!(keys(&written), ["nodes", "edges", "lines", "facets", "tags"]);
    let node = first(member(&written, "nodes"));
    assert_eq!(
        keys(node),
        [
            "id",
            "x",
            "y",
            "width",
            "height",
            "color",
            "embed",
            "facets",
            "tags",
            "resource",
            "label",
            "background",
            "backgroundStyle"
        ]
    );
    assert_eq!(keys(member(node, "embed")), ["documentId", "versionRef"]);
    assert_eq!(keys(member(node, "resource")), ["mimeType", "content", "location", "subpath"]);
    let edge = first(member(&written, "edges"));
    assert_eq!(keys(edge), ["id", "from", "to", "color", "label", "facets", "tags", "bends"]);
    assert_eq!(keys(member(edge, "from")), ["node", "side", "end"]);
    let line = first(member(&written, "lines"));
    assert_eq!(keys(line), ["id", "from", "to", "label", "bends", "facets"]);
    assert_eq!(keys(member(line, "from")), ["kind", "node", "side"]);
    assert_eq!(keys(member(line, "to")), ["kind", "point", "end"]);
    assert_eq!(member(member(line, "to"), "kind"), &Value::String("point".into()));
}

#[test]
fn a_canvas_is_read_in_any_key_order() {
    let text = r##"{"edges":[{"to":{"end":"arrow","node":"b"},"from":{"node":"a"},"id":"e"}],
        "tags":["t"],"nodes":[{"height":2,"width":1,"y":0,"x":0,"id":"a","color":"6"},
        {"id":"b","x":0,"y":0,"width":1,"height":1,"color":"#abc"}],
        "lines":[{"id":"i","from":{"point":{"y":2,"x":1},"kind":"point"},"to":{"node":"a","kind":"node","side":"top"}}]}"##;
    let canvas = canvas_of(&value(text)).expect("a canvas");
    assert_eq!(canvas.nodes.len(), 2);
    assert_eq!(canvas.nodes[0].height.to_bits(), 2.0_f64.to_bits());
    assert_eq!(canvas.nodes[1].color, Some(CanvasColor::CanvasColorHex("#abc".into())));
    assert_eq!(canvas.edges[0].to.end, Arrowhead::from_wire("arrow"));
    assert_eq!(canvas.tags, Some(vec!["t".into()]));
    let line = &canvas.lines.as_ref().expect("lines")[0];
    assert_eq!(
        line.from,
        LineEnd::LineEndPoint(LineEndPoint { point: CanvasPoint { x: 1.0, y: 2.0 }, end: None })
    );
}

const NODE: &str = r#""id":"a","x":0,"y":0,"width":1,"height":1"#;
const POINT: &str = r#"{"kind":"point","point":{"x":1,"y":1}}"#;

/// A canvas holding one node, one edge and one line, each spelled by its text.
fn canvas_text(node: &str, edge: &str, line: &str) -> String {
    format!(r#"{{"nodes":[{node}],"edges":[{edge}],"lines":[{line}]}}"#)
}

fn well_formed(node: &str, edge: &str, line: &str) -> bool {
    canvas_of(&value(&canvas_text(node, edge, line))).is_some()
}

const EDGE: &str = r#"{"id":"e","from":{"node":"a"},"to":{"node":"a"}}"#;

fn line_text() -> String {
    format!(r#"{{"id":"i","from":{POINT},"to":{POINT}}}"#)
}

#[test]
fn a_well_formed_replacement_in_each_list_is_read() {
    // The control for the refusals below.
    assert!(well_formed(&format!("{{{NODE}}}"), EDGE, &line_text()));
}

fn assert_refused(cases: &[(&str, String)]) {
    for (what, text) in cases {
        assert_eq!(canvas_of(&value(text)), None, "{what}: {text}");
    }
}

#[test]
fn a_canvas_of_the_wrong_shape_is_refused() {
    let root = |tail: &str| format!(r#"{{"nodes":[],"edges":[]{tail}}}"#);
    assert_refused(&[
        ("the root is a list", "[]".into()),
        ("no nodes", r#"{"edges":[]}"#.into()),
        ("no edges", r#"{"nodes":[]}"#.into()),
        ("nodes is a map", r#"{"nodes":{},"edges":[]}"#.into()),
        ("an unnamed root key", root(r#","comments":[]"#)),
        ("lines is not a list", root(r#","lines":null"#)),
        ("facets is a list", root(r#","facets":[]"#)),
        ("a tag that is a number", root(r#","tags":[1]"#)),
        ("tags is a string", root(r#","tags":"t""#)),
    ]);
}

#[test]
fn a_node_of_the_wrong_shape_is_refused() {
    let node = |text: &str| canvas_text(text, EDGE, &line_text());
    let tail = |tail: &str| node(&format!("{{{NODE},{tail}}}"));
    assert_refused(&[
        ("a node that is a string", node(r#""a""#)),
        ("a node without an id", node(r#"{"x":0,"y":0,"width":1,"height":1}"#)),
        ("a node without a size", node(r#"{"id":"a","x":0,"y":0,"width":1}"#)),
        ("a text x", node(r#"{"id":"a","x":"0","y":0,"width":1,"height":1}"#)),
        ("an unnamed key", tail(r#""z":1"#)),
        ("a numeric color", tail(r#""color":1"#)),
        ("a bad style", tail(r#""backgroundStyle":"tile""#)),
        ("an embed without a document", tail(r#""embed":{"versionRef":"v"}"#)),
        ("an embed with an unnamed key", tail(r#""embed":{"documentId":"d","q":1}"#)),
        ("a resource without a type", tail(r#""resource":{"content":"c"}"#)),
        ("a resource with an unnamed key", tail(r#""resource":{"mimeType":"m","q":1}"#)),
    ]);
}

#[test]
fn an_edge_of_the_wrong_shape_is_refused() {
    let edge = |text: &str| canvas_text(&format!("{{{NODE}}}"), text, &line_text());
    let ends = |from: &str, tail: &str| {
        edge(&format!(r#"{{"id":"e","from":{from},"to":{{"node":"b"}}{tail}}}"#))
    };
    let a = r#"{"node":"a"}"#;
    assert_refused(&[
        ("an edge without an end", edge(r#"{"id":"e","from":{"node":"a"}}"#)),
        ("a bad side", ends(r#"{"node":"a","side":"middle"}"#, "")),
        ("a bad arrow", ends(r#"{"node":"a","end":"dot"}"#, "")),
        ("an end without a node", ends(r#"{"side":"left"}"#, "")),
        ("an end with an unnamed key", ends(r#"{"node":"a","q":1}"#, "")),
        ("an unnamed key", ends(a, r#","q":1"#)),
        ("a bend that is no point", ends(a, r#","bends":[{"x":1}]"#)),
        ("a bend with an unnamed key", ends(a, r#","bends":[{"x":1,"y":1,"z":1}]"#)),
    ]);
}

#[test]
fn a_line_of_the_wrong_shape_is_refused() {
    let line = |from: &str, tail: &str| {
        let text = format!(r#"{{"id":"i","from":{from},"to":{POINT}{tail}}}"#);
        canvas_text(&format!("{{{NODE}}}"), EDGE, &text)
    };
    assert_refused(&[
        ("an end of no kind", line(r#"{"node":"a"}"#, "")),
        ("an end of another kind", line(r#"{"kind":"edge","node":"a"}"#, "")),
        (
            "a node end with a point",
            line(r#"{"kind":"node","node":"a","point":{"x":1,"y":1}}"#, ""),
        ),
        (
            "a point end with a node",
            line(r#"{"kind":"point","node":"a","point":{"x":1,"y":1}}"#, ""),
        ),
        ("a point end without a point", line(r#"{"kind":"point"}"#, "")),
        ("a line with tags", line(POINT, r#","tags":[]"#)),
    ]);
}

use super::{canvas_from, canvas_json, json_value, value_json};
use serde_json::{Value as Json, json};
use whiteboard_model::Value;
use whiteboard_model::spatial::{
    Arrowhead, BackgroundStyle, CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine,
    CanvasPoint, EdgeEnd, EdgeSide, LineEnd, LineEndNode, LineEndPoint, NodeEmbed, NodeResource,
    SpatialCanvas, SpatialNode,
};

#[test]
fn a_safe_integer_is_itself_and_any_other_number_is_its_bits() {
    let wire = |n: f64| value_json(&Value::Number(n));
    assert_eq!(wire(3.0), json!(3));
    assert_eq!(wire(-12.0), json!(-12));
    assert_eq!(wire(0.0), json!(0));
    assert_eq!(wire(9_007_199_254_740_991.0), json!(9_007_199_254_740_991_i64));
    assert_eq!(wire(-9_007_199_254_740_991.0), json!(-9_007_199_254_740_991_i64));
    assert_eq!(wire(9_007_199_254_740_992.0), json!(["f", "4340000000000000"]));
    assert_eq!(wire(-0.0), json!(["f", "8000000000000000"]));
    assert_eq!(wire(1.5), json!(["f", "3ff8000000000000"]));
    assert_eq!(wire(f64::NAN), json!(["f", "7ff8000000000000"]));
    assert_eq!(wire(f64::NEG_INFINITY), json!(["f", "fff0000000000000"]));
}

#[test]
fn a_value_reads_back_as_the_wire_wrote_it() {
    let value = Value::Map(vec![
        ("1".into(), Value::Seq(vec![Value::Null, Value::Bool(true), Value::Number(-0.0)])),
        ("k".into(), Value::BigInt("9007199254740993".into())),
        ("__proto__".into(), Value::String("\u{1F600}".into())),
        ("n".into(), Value::Number(2.5)),
    ]);
    let read = json_value(&value_json(&value));
    assert_eq!(read.as_ref(), Some(&value));
    let bits = |v: &Value| match v {
        Value::Map(entries) => match &entries[0].1 {
            Value::Seq(items) => matches!(&items[2], Value::Number(n) if n.is_sign_negative()),
            _ => false,
        },
        _ => false,
    };
    assert!(read.as_ref().is_some_and(bits));
}

#[test]
fn a_wire_that_is_no_value_is_none() {
    for wire in [
        json!({}),
        json!(1.5),
        json!(1e3),
        json!(9_007_199_254_740_992_i64),
        json!(-9_007_199_254_740_992_i64),
        json!(u64::MAX),
        json!([]),
        json!(["x"]),
        json!(["f"]),
        json!(["f", "3ff8"]),
        json!(["f", "3ff800000000000g"]),
        json!(["f", 1]),
        json!(["b", 1]),
        json!(["m", "a"]),
        json!(["m", 1, null]),
        json!(["m", "a", null, "a", null]),
        json!(["s", {}]),
        json!([1, "a"]),
    ] {
        assert_eq!(json_value(&wire), None, "{wire}");
    }
    assert_eq!(
        json_value(&json!(9_007_199_254_740_991_i64)),
        Some(Value::Number(9_007_199_254_740_991.0))
    );
    assert_eq!(json_value(&json!(["f", "3FF8000000000000"])), Some(Value::Number(1.5)));
}

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

#[test]
fn a_canvas_with_every_field_reads_back_as_itself() {
    let canvas = full();
    assert_eq!(canvas_from(&canvas_json(&canvas)), Some(canvas));
    let empty = SpatialCanvas::default();
    assert_eq!(canvas_json(&empty), json!(["m", "nodes", ["s"], "edges", ["s"]]));
    assert_eq!(canvas_from(&canvas_json(&empty)), Some(empty));
}

#[test]
fn an_edge_is_written_in_the_order_the_typescript_lifts_it() {
    let wire = canvas_json(&full());
    let edge = wire[4][1].as_array().cloned().unwrap_or_default();
    let keys: Vec<&str> = edge.iter().skip(1).step_by(2).filter_map(Json::as_str).collect();
    assert_eq!(keys, ["id", "from", "to", "color", "label", "facets", "tags", "bends"]);
}

#[test]
fn the_wire_names_each_field_in_the_contracts_order() {
    let wire = canvas_json(&full()).to_string();
    let at = |needle: &str| wire.find(needle).unwrap_or(usize::MAX);
    let order = [
        "\"nodes\"",
        "\"id\"",
        "\"width\"",
        "\"color\"",
        "\"embed\"",
        "\"documentId\"",
        "\"versionRef\"",
        "\"facets\"",
        "\"tags\"",
        "\"resource\"",
        "\"mimeType\"",
        "\"content\"",
        "\"location\"",
        "\"subpath\"",
        "\"label\"",
        "\"background\"",
        "\"backgroundStyle\"",
        "\"edges\"",
        "\"from\"",
        "\"side\"",
        "\"end\"",
        "\"bends\"",
        "\"lines\"",
        "\"kind\"",
        "\"point\"",
    ];
    let places: Vec<usize> = order.iter().map(|n| at(n)).collect();
    assert!(places.iter().all(|p| *p != usize::MAX), "{places:?}");
    assert!(places.windows(2).all(|w| w[0] < w[1]), "{places:?}");
}

/// `full()`'s wire with its first element of the list at `slot` (2 nodes,
/// 4 edges, 6 lines) replaced by `element`.
fn replacing(slot: usize, element: Json) -> Json {
    let mut wire = canvas_json(&full());
    wire[slot][1] = element;
    wire
}

#[test]
fn a_well_formed_replacement_in_each_list_is_read() {
    // The control for the refusals below: they replace the first element of
    // a list, so a replacement that is fine must not be refused.
    let end = json!(["m", "node", "a"]);
    let point = json!(["m", "kind", "point", "point", ["m", "x", 1, "y", 1]]);
    for (slot, element) in [
        (2, json!(["m", "id", "a", "x", 0, "y", 0, "width", 1, "height", 1])),
        (4, json!(["m", "id", "e", "from", end, "to", end])),
        (6, json!(["m", "id", "i", "from", point, "to", point])),
    ] {
        assert!(canvas_from(&replacing(slot, element)).is_some(), "slot {slot}");
    }
}

fn assert_refused(cases: Vec<(&str, Json)>) {
    for (what, wire) in cases {
        assert_eq!(canvas_from(&wire), None, "{what}: {wire}");
    }
}

#[test]
fn a_canvas_of_the_wrong_shape_is_refused() {
    let root = |tail: Json| {
        let mut wire = vec![json!("m"), json!("nodes"), json!(["s"]), json!("edges"), json!(["s"])];
        wire.extend(tail.as_array().cloned().unwrap_or_default());
        Json::Array(wire)
    };
    assert_refused(vec![
        ("the root is a list", json!(["s"])),
        ("no nodes", json!(["m", "edges", ["s"]])),
        ("no edges", json!(["m", "nodes", ["s"]])),
        ("nodes is a map", json!(["m", "nodes", ["m"], "edges", ["s"]])),
        ("an unnamed root key", root(json!(["comments", ["s"]]))),
        ("lines is not a list", root(json!(["lines", null]))),
        ("facets is a list", root(json!(["facets", ["s"]]))),
        ("a tag that is a number", root(json!(["tags", ["s", 1]]))),
        ("tags is a string", root(json!(["tags", "t"]))),
    ]);
}

#[test]
fn a_node_of_the_wrong_shape_is_refused() {
    let node = |tail: Json| {
        let base = json!(["m", "id", "a", "x", 0, "y", 0, "width", 1, "height", 1]);
        let mut wire = base.as_array().cloned().unwrap_or_default();
        wire.extend(tail.as_array().cloned().unwrap_or_default());
        replacing(2, Json::Array(wire))
    };
    assert_refused(vec![
        ("a node that is a string", replacing(2, json!("a"))),
        (
            "a node without an id",
            replacing(2, json!(["m", "x", 0, "y", 0, "width", 1, "height", 1])),
        ),
        (
            "a node without a size",
            replacing(2, json!(["m", "id", "a", "x", 0, "y", 0, "width", 1])),
        ),
        (
            "a text x",
            replacing(2, json!(["m", "id", "a", "x", "0", "y", 0, "width", 1, "height", 1])),
        ),
        ("an unnamed key", node(json!(["z", 1]))),
        ("a numeric color", node(json!(["color", 1]))),
        ("a bad style", node(json!(["backgroundStyle", "tile"]))),
        ("an embed without a document", node(json!(["embed", ["m", "versionRef", "v"]]))),
        ("an embed with an unnamed key", node(json!(["embed", ["m", "documentId", "d", "q", 1]]))),
        ("a resource without a type", node(json!(["resource", ["m", "content", "c"]]))),
        (
            "a resource with an unnamed key",
            node(json!(["resource", ["m", "mimeType", "m", "q", 1]])),
        ),
    ]);
}

#[test]
fn an_edge_of_the_wrong_shape_is_refused() {
    let ends = |from: Json, to: Json, tail: Json| {
        let mut wire =
            vec![json!("m"), json!("id"), json!("e"), json!("from"), from, json!("to"), to];
        wire.extend(tail.as_array().cloned().unwrap_or_default());
        replacing(4, Json::Array(wire))
    };
    let (a, b) = (json!(["m", "node", "a"]), json!(["m", "node", "b"]));
    assert_refused(vec![
        (
            "an edge without an end",
            replacing(4, json!(["m", "id", "e", "from", ["m", "node", "a"]])),
        ),
        ("a bad side", ends(json!(["m", "node", "a", "side", "middle"]), b.clone(), json!([]))),
        ("a bad arrow", ends(json!(["m", "node", "a", "end", "dot"]), b.clone(), json!([]))),
        ("an end without a node", ends(json!(["m", "side", "left"]), b.clone(), json!([]))),
        (
            "an end with an unnamed key",
            ends(json!(["m", "node", "a", "q", 1]), b.clone(), json!([])),
        ),
        ("an unnamed key", ends(a.clone(), b.clone(), json!(["q", 1]))),
        (
            "a bend that is no point",
            ends(a.clone(), b.clone(), json!(["bends", ["s", ["m", "x", 1]]])),
        ),
        (
            "a bend with an unnamed key",
            ends(a, b, json!(["bends", ["s", ["m", "x", 1, "y", 1, "z", 1]]])),
        ),
    ]);
}

#[test]
fn a_line_of_the_wrong_shape_is_refused() {
    let point = json!(["m", "kind", "point", "point", ["m", "x", 1, "y", 1]]);
    let line = |from: Json, tail: Json| {
        let mut wire = vec![
            json!("m"),
            json!("id"),
            json!("i"),
            json!("from"),
            from,
            json!("to"),
            point.clone(),
        ];
        wire.extend(tail.as_array().cloned().unwrap_or_default());
        replacing(6, Json::Array(wire))
    };
    assert_refused(vec![
        ("an end of no kind", line(json!(["m", "node", "a"]), json!([]))),
        ("an end of another kind", line(json!(["m", "kind", "edge", "node", "a"]), json!([]))),
        (
            "a node end with a point",
            line(
                json!(["m", "kind", "node", "node", "a", "point", ["m", "x", 1, "y", 1]]),
                json!([]),
            ),
        ),
        (
            "a point end with a node",
            line(
                json!(["m", "kind", "point", "node", "a", "point", ["m", "x", 1, "y", 1]]),
                json!([]),
            ),
        ),
        ("a point end without a point", line(json!(["m", "kind", "point"]), json!([]))),
        ("a line with tags", line(point.clone(), json!(["tags", ["s"]]))),
    ]);
}

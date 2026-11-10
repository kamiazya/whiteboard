//! The JSON Canvas exports' canvas wire: a [`SpatialCanvas`] as JSON, and back.
//!
//! A canvas is a value: an object is `["m", key, item, ...]` in the order the
//! host enumerates it, a list `["s", item, ...]`, and `null`, a boolean and a
//! string are themselves. A number is its own JSON integer when it is a safe
//! integer other than `-0` (a canvas holds hundreds of them and their 16 hex
//! digits would be most of the wire), and `["f", hex]`, the 64 bits of the
//! double, otherwise; `["b", digits]` is a `bigint`. One array per collection,
//! so a value nested to the writer's depth stays inside `serde_json`'s
//! recursion limit.
//!
//! The canvas's own objects are written in the order the TypeScript lifts them
//! in (`fromJsonCanvas`: the contract's field order but for an edge's `bends`,
//! which it puts last), an absent field left out, since a host sees the order
//! of an object's keys; they are read in any order, and strictly: a key the contract does not name,
//! a field of another kind or a missing required one is no canvas, and the
//! export refuses it as malformed so that the host's TypeScript answers.

use serde_json::{Number, Value as Json, json};
use std::collections::BTreeSet;
use whiteboard_model::spatial::{
    Arrowhead, BackgroundStyle, CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine,
    CanvasPoint, EdgeEnd, EdgeSide, LineEnd, LineEndNode, LineEndPoint, NodeEmbed, NodeResource,
    SpatialCanvas, SpatialNode,
};
use whiteboard_model::{Map, Value};

/// The largest integer a double holds exactly, and the largest a wire number spells as one.
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

fn safe_integer(n: f64) -> Option<i64> {
    let whole = n.fract() == 0.0 && n.abs() <= MAX_SAFE && !(n == 0.0 && n.is_sign_negative());
    if whole { format!("{n}").parse().ok() } else { None }
}

/// The wire of a value.
pub fn value_json(value: &Value) -> Json {
    match value {
        Value::Null => Json::Null,
        Value::Bool(b) => json!(b),
        Value::String(s) => json!(s),
        Value::Number(n) => match safe_integer(*n) {
            Some(whole) => Json::Number(Number::from(whole)),
            None => json!(["f", format!("{:016x}", n.to_bits())]),
        },
        Value::BigInt(digits) => json!(["b", digits]),
        Value::Seq(items) => {
            Json::Array(std::iter::once(json!("s")).chain(items.iter().map(value_json)).collect())
        }
        Value::Map(entries) => Json::Array(
            std::iter::once(json!("m"))
                .chain(entries.iter().flat_map(|(key, item)| [json!(key), value_json(item)]))
                .collect(),
        ),
    }
}

/// The value a wire stands for, or `None` when it is not one: an object, a
/// number that is not a safe integer, an unknown tag, a double that is not
/// sixteen hex digits, a mapping with an odd tail, a non-string key or a key
/// held twice (a host object cannot hold one).
pub fn json_value(wire: &Json) -> Option<Value> {
    Some(match wire {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::String(s) => Value::String(s.clone()),
        Json::Number(n) => Value::Number(whole_number(n)?),
        Json::Object(_) => return None,
        Json::Array(parts) => {
            let (tag, rest) = parts.split_first()?;
            match (tag.as_str()?, rest) {
                ("f", [Json::String(hex)]) => Value::Number(f64::from_bits(bits(hex)?)),
                ("b", [Json::String(digits)]) => Value::BigInt(digits.clone()),
                ("s", items) => Value::Seq(items.iter().map(json_value).collect::<Option<_>>()?),
                ("m", pairs) => Value::Map(entries(pairs)?),
                _ => return None,
            }
        }
    })
}

fn whole_number(n: &Number) -> Option<f64> {
    if !(n.is_i64() || n.is_u64()) {
        return None;
    }
    n.as_f64().filter(|whole| whole.abs() <= MAX_SAFE)
}

fn bits(hex: &str) -> Option<u64> {
    if hex.len() == 16 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        None
    }
}

fn entries(pairs: &[Json]) -> Option<Map> {
    let mut seen = BTreeSet::new();
    pairs
        .chunks(2)
        .map(|pair| {
            let [Json::String(key), item] = pair else { return None };
            seen.insert(key.as_str()).then_some(())?;
            Some((key.clone(), json_value(item)?))
        })
        .collect()
}

// ---------------------------------------------------------------- the canvas as a value

type Members = Vec<(&'static str, Option<Value>)>;

fn object(fields: Members) -> Value {
    Value::Map(fields.into_iter().filter_map(|(k, v)| Some((k.to_string(), v?))).collect())
}

fn text(s: &str) -> Value {
    Value::String(s.to_string())
}

fn some_text(s: Option<&String>) -> Option<Value> {
    s.map(|s| text(s))
}

fn tags_value(tags: Option<&Vec<String>>) -> Option<Value> {
    tags.map(|t| Value::Seq(t.iter().map(|s| text(s)).collect()))
}

fn facets_value(facets: Option<&Map>) -> Option<Value> {
    facets.map(|f| Value::Map(f.clone()))
}

fn color_value(color: Option<&CanvasColor>) -> Option<Value> {
    color.map(|c| match c {
        CanvasColor::CanvasColorPreset(p) => text(p.as_str()),
        CanvasColor::CanvasColorHex(h) => text(h),
    })
}

fn point_value(p: &CanvasPoint) -> Value {
    object(vec![("x", Some(Value::Number(p.x))), ("y", Some(Value::Number(p.y)))])
}

fn bends_value(bends: Option<&Vec<CanvasPoint>>) -> Option<Value> {
    bends.map(|b| Value::Seq(b.iter().map(point_value).collect()))
}

fn side_value(side: Option<EdgeSide>) -> Option<Value> {
    side.map(|s| text(s.as_str()))
}

fn arrow_value(end: Option<Arrowhead>) -> Option<Value> {
    end.map(|e| text(e.as_str()))
}

fn node_value(n: &SpatialNode) -> Value {
    let embed = n.embed.as_ref().map(|e| {
        object(vec![
            ("documentId", Some(text(&e.document_id))),
            ("versionRef", some_text(e.version_ref.as_ref())),
        ])
    });
    let resource = n.resource.as_ref().map(|r| {
        object(vec![
            ("mimeType", Some(text(&r.mime_type))),
            ("content", some_text(r.content.as_ref())),
            ("location", some_text(r.location.as_ref())),
            ("subpath", some_text(r.subpath.as_ref())),
        ])
    });
    object(vec![
        ("id", Some(text(&n.id))),
        ("x", Some(Value::Number(n.x))),
        ("y", Some(Value::Number(n.y))),
        ("width", Some(Value::Number(n.width))),
        ("height", Some(Value::Number(n.height))),
        ("color", color_value(n.color.as_ref())),
        ("embed", embed),
        ("facets", facets_value(n.facets.as_ref())),
        ("tags", tags_value(n.tags.as_ref())),
        ("resource", resource),
        ("label", some_text(n.label.as_ref())),
        ("background", some_text(n.background.as_ref())),
        ("backgroundStyle", n.background_style.map(|s| text(s.as_str()))),
    ])
}

fn edge_end_value(e: &EdgeEnd) -> Value {
    object(vec![
        ("node", Some(text(&e.node))),
        ("side", side_value(e.side)),
        ("end", arrow_value(e.end)),
    ])
}

fn edge_value(e: &CanvasEdge) -> Value {
    object(vec![
        ("id", Some(text(&e.id))),
        ("from", Some(edge_end_value(&e.from))),
        ("to", Some(edge_end_value(&e.to))),
        ("color", color_value(e.color.as_ref())),
        ("label", some_text(e.label.as_ref())),
        ("facets", facets_value(e.facets.as_ref())),
        ("tags", tags_value(e.tags.as_ref())),
        ("bends", bends_value(e.bends.as_ref())),
    ])
}

fn line_end_value(e: &LineEnd) -> Value {
    match e {
        LineEnd::LineEndNode(n) => object(vec![
            ("kind", Some(text(LineEndNode::KIND))),
            ("node", Some(text(&n.node))),
            ("side", side_value(n.side)),
            ("end", arrow_value(n.end)),
        ]),
        LineEnd::LineEndPoint(p) => object(vec![
            ("kind", Some(text(LineEndPoint::KIND))),
            ("point", Some(point_value(&p.point))),
            ("end", arrow_value(p.end)),
        ]),
    }
}

fn line_value(l: &CanvasLine) -> Value {
    object(vec![
        ("id", Some(text(&l.id))),
        ("from", Some(line_end_value(&l.from))),
        ("to", Some(line_end_value(&l.to))),
        ("color", color_value(l.color.as_ref())),
        ("label", some_text(l.label.as_ref())),
        ("bends", bends_value(l.bends.as_ref())),
        ("facets", facets_value(l.facets.as_ref())),
    ])
}

/// The wire of a canvas.
pub fn canvas_json(c: &SpatialCanvas) -> Json {
    value_json(&object(vec![
        ("nodes", Some(Value::Seq(c.nodes.iter().map(node_value).collect()))),
        ("edges", Some(Value::Seq(c.edges.iter().map(edge_value).collect()))),
        ("lines", c.lines.as_ref().map(|l| Value::Seq(l.iter().map(line_value).collect()))),
        ("facets", facets_value(c.facets.as_ref())),
        ("tags", tags_value(c.tags.as_ref())),
    ]))
}

// ---------------------------------------------------------------- the value as a canvas

/// An object being read: the keys the contract names are taken, and what is
/// left over makes it no canvas object.
struct Fields<'a> {
    entries: &'a Map,
    taken: usize,
}

type Read<T> = Option<Option<T>>;

impl<'a> Fields<'a> {
    fn of(value: &'a Value) -> Option<Self> {
        match value {
            Value::Map(entries) => Some(Self { entries, taken: 0 }),
            _ => None,
        }
    }

    /// The field `name` read by `read`: `None` for one that is malformed,
    /// `Some(None)` for one that is absent.
    fn field<T>(&mut self, name: &str, read: impl FnOnce(&'a Value) -> Option<T>) -> Read<T> {
        let Some((_, value)) = self.entries.iter().find(|(key, _)| key == name) else {
            return Some(None);
        };
        self.taken = self.taken.saturating_add(1);
        read(value).map(Some)
    }

    /// Whether every key was one the contract names.
    fn all_named(&self) -> bool {
        self.taken == self.entries.len()
    }
}

fn string_of(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn number_of(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => Some(*n),
        _ => None,
    }
}

fn items_of<T>(value: &Value, read: impl Fn(&Value) -> Option<T>) -> Option<Vec<T>> {
    match value {
        Value::Seq(items) => items.iter().map(read).collect(),
        _ => None,
    }
}

fn facets_of(value: &Value) -> Option<Map> {
    match value {
        Value::Map(entries) => Some(entries.clone()),
        _ => None,
    }
}

fn tags_of(value: &Value) -> Option<Vec<String>> {
    items_of(value, string_of)
}

fn color_of(value: &Value) -> Option<CanvasColor> {
    let color = string_of(value)?;
    Some(match CanvasColorPreset::from_wire(&color) {
        Some(preset) => CanvasColor::CanvasColorPreset(preset),
        None => CanvasColor::CanvasColorHex(color),
    })
}

fn side_of(value: &Value) -> Option<EdgeSide> {
    EdgeSide::from_wire(&string_of(value)?)
}

fn arrow_of(value: &Value) -> Option<Arrowhead> {
    Arrowhead::from_wire(&string_of(value)?)
}

fn point_of(value: &Value) -> Option<CanvasPoint> {
    let mut f = Fields::of(value)?;
    let (x, y) = (f.field("x", number_of)??, f.field("y", number_of)??);
    f.all_named().then_some(CanvasPoint { x, y })
}

fn bends_of(value: &Value) -> Option<Vec<CanvasPoint>> {
    items_of(value, point_of)
}

fn embed_of(value: &Value) -> Option<NodeEmbed> {
    let mut f = Fields::of(value)?;
    let document_id = f.field("documentId", string_of)??;
    let version_ref = f.field("versionRef", string_of)?;
    f.all_named().then_some(NodeEmbed { document_id, version_ref })
}

fn resource_of(value: &Value) -> Option<NodeResource> {
    let mut f = Fields::of(value)?;
    let mime_type = f.field("mimeType", string_of)??;
    let content = f.field("content", string_of)?;
    let location = f.field("location", string_of)?;
    let subpath = f.field("subpath", string_of)?;
    f.all_named().then_some(NodeResource { mime_type, content, location, subpath })
}

fn node_of(value: &Value) -> Option<SpatialNode> {
    let mut f = Fields::of(value)?;
    let node = SpatialNode {
        id: f.field("id", string_of)??,
        x: f.field("x", number_of)??,
        y: f.field("y", number_of)??,
        width: f.field("width", number_of)??,
        height: f.field("height", number_of)??,
        color: f.field("color", color_of)?,
        embed: f.field("embed", embed_of)?,
        facets: f.field("facets", facets_of)?,
        tags: f.field("tags", tags_of)?,
        resource: f.field("resource", resource_of)?,
        label: f.field("label", string_of)?,
        background: f.field("background", string_of)?,
        background_style: f
            .field("backgroundStyle", |v| BackgroundStyle::from_wire(&string_of(v)?))?,
    };
    f.all_named().then_some(node)
}

fn edge_end_of(value: &Value) -> Option<EdgeEnd> {
    let mut f = Fields::of(value)?;
    let end = EdgeEnd {
        node: f.field("node", string_of)??,
        side: f.field("side", side_of)?,
        end: f.field("end", arrow_of)?,
    };
    f.all_named().then_some(end)
}

fn edge_of(value: &Value) -> Option<CanvasEdge> {
    let mut f = Fields::of(value)?;
    let edge = CanvasEdge {
        id: f.field("id", string_of)??,
        from: f.field("from", edge_end_of)??,
        to: f.field("to", edge_end_of)??,
        color: f.field("color", color_of)?,
        label: f.field("label", string_of)?,
        bends: f.field("bends", bends_of)?,
        facets: f.field("facets", facets_of)?,
        tags: f.field("tags", tags_of)?,
    };
    f.all_named().then_some(edge)
}

fn line_end_of(value: &Value) -> Option<LineEnd> {
    let mut f = Fields::of(value)?;
    let kind = f.field("kind", string_of)??;
    let end = f.field("end", arrow_of)?;
    let ready = if kind == LineEndNode::KIND {
        let (node, side) = (f.field("node", string_of)??, f.field("side", side_of)?);
        LineEnd::LineEndNode(LineEndNode { node, side, end })
    } else if kind == LineEndPoint::KIND {
        LineEnd::LineEndPoint(LineEndPoint { point: f.field("point", point_of)??, end })
    } else {
        return None;
    };
    // `kind` is read as a field, so a node end's `point` is an unnamed key here.
    f.all_named().then_some(ready)
}

fn line_of(value: &Value) -> Option<CanvasLine> {
    let mut f = Fields::of(value)?;
    let line = CanvasLine {
        id: f.field("id", string_of)??,
        from: f.field("from", line_end_of)??,
        to: f.field("to", line_end_of)??,
        color: f.field("color", color_of)?,
        label: f.field("label", string_of)?,
        bends: f.field("bends", bends_of)?,
        facets: f.field("facets", facets_of)?,
    };
    f.all_named().then_some(line)
}

fn canvas_of(value: &Value) -> Option<SpatialCanvas> {
    let mut f = Fields::of(value)?;
    let canvas = SpatialCanvas {
        nodes: f.field("nodes", |v| items_of(v, node_of))??,
        edges: f.field("edges", |v| items_of(v, edge_of))??,
        lines: f.field("lines", |v| items_of(v, line_of))?,
        facets: f.field("facets", facets_of)?,
        tags: f.field("tags", tags_of)?,
    };
    f.all_named().then_some(canvas)
}

/// The canvas a wire stands for, or `None` when it is no canvas.
pub fn canvas_from(wire: &Json) -> Option<SpatialCanvas> {
    canvas_of(&json_value(wire)?)
}

#[cfg(test)]
mod tests {
    use super::{canvas_from, canvas_json, json_value, value_json};
    use serde_json::{Value as Json, json};
    use whiteboard_model::Value;
    use whiteboard_model::spatial::{
        Arrowhead, BackgroundStyle, CanvasColor, CanvasColorPreset, CanvasEdge, CanvasLine,
        CanvasPoint, EdgeEnd, EdgeSide, LineEnd, LineEndNode, LineEndPoint, NodeEmbed,
        NodeResource, SpatialCanvas, SpatialNode,
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

    fn full() -> SpatialCanvas {
        let point = |x, y| CanvasPoint { x, y };
        let node = SpatialNode {
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
        };
        let end = |node: &str| EdgeEnd {
            node: node.into(),
            side: EdgeSide::from_wire("left"),
            end: Arrowhead::from_wire("arrow"),
        };
        SpatialCanvas {
            nodes: vec![node],
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
            let mut wire =
                vec![json!("m"), json!("nodes"), json!(["s"]), json!("edges"), json!(["s"])];
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
            (
                "an embed with an unnamed key",
                node(json!(["embed", ["m", "documentId", "d", "q", 1]])),
            ),
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
}

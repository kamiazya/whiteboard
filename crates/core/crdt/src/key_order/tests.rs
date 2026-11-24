use super::*;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen_test::wasm_bindgen_test as test;
use whiteboard_model::json;

const SPATIAL: &str = include_str!("../../../../../contracts/model/spatial.schema.json");
const OKF: &str = include_str!("../../../../../contracts/model/okf.schema.json");

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Map(entries) => entries.iter().find(|(key, _)| key == name).map(|(_, held)| held),
        _ => None,
    }
}

fn texts(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Seq(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(text) => text.clone(),
                other => panic!("a key, not {other:?}"),
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The keys a contract's definition declares, in the order its zod is
/// generated with: the definition it extends first, then its own.
fn declared(contract: &str, name: &str) -> Vec<String> {
    let parsed = json::parse(contract).expect("a contract");
    let defs = field(&parsed, "$defs").expect("definitions");
    let def = field(defs, name).unwrap_or_else(|| panic!("{name} is defined"));
    let mut keys = match field(def, "x-wb-extends") {
        Some(Value::String(base)) => declared(contract, base),
        _ => Vec::new(),
    };
    keys.extend(texts(field(def, "x-wb-order")));
    keys
}

fn owned(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|key| (*key).to_owned()).collect()
}

#[test]
fn the_spatial_orders_are_the_contracts() {
    for (list, name) in [
        (NODE, "SpatialNode"),
        (RESOURCE, "NodeResource"),
        (EMBED, "NodeEmbed"),
        (EDGE, "CanvasEdge"),
        (EDGE_END, "EdgeEnd"),
        (LINE, "CanvasLine"),
        (CANVAS, "SpatialCanvas"),
    ] {
        assert_eq!(owned(list), declared(SPATIAL, name), "{name}");
    }
}

#[test]
fn a_line_end_holds_each_arm_in_its_order() {
    for arm in ["LineEndNode", "LineEndPoint"] {
        let kept: Vec<String> = owned(LINE_END)
            .into_iter()
            .filter(|key| declared(SPATIAL, arm).contains(key))
            .collect();
        assert_eq!(kept, declared(SPATIAL, arm), "{arm}");
    }
}

#[test]
fn the_okf_orders_are_the_contracts() {
    let core: Vec<String> =
        declared(OKF, "CoreFacets").into_iter().filter(|key| key != "title").collect();
    assert_eq!(owned(&CORE[..CORE.len() - 1]), core, "storedCoreFacetsSchema omits title");
    assert_eq!(owned(TRUST_EVENT), declared(OKF, "OkfTrustEvent"));
    let trust: Vec<String> = declared(OKF, "OkfMarkdownFrontmatter")
        .into_iter()
        .filter(|key| TRUST.contains(&key.as_str()))
        .collect();
    assert_eq!(owned(TRUST), trust);
}

fn object(keys: &[&str]) -> Value {
    Value::Map(keys.iter().map(|key| ((*key).to_owned(), Value::Null)).collect())
}

fn keys(value: &Value) -> Vec<&str> {
    match value {
        Value::Map(entries) => entries.iter().map(|(key, _)| key.as_str()).collect(),
        _ => Vec::new(),
    }
}

#[test]
fn array_indices_lead_then_the_shape_then_the_rest_as_held() {
    let held = object(&["zed", "at", "10", "by", "01", "2", "alpha", "4294967295", "0"]);
    let written = shaped(held, TRUST_EVENT, flat);
    assert_eq!(keys(&written), ["0", "2", "10", "by", "at", "zed", "01", "alpha", "4294967295"]);
}

#[test]
fn a_point_is_written_in_its_schemas_order_without_reordering() {
    let ascending: Vec<String> = declared(SPATIAL, "CanvasPoint");
    let mut sorted = ascending.clone();
    sorted.sort();
    assert_eq!(ascending, sorted, "a point's keys would need an order of their own");
}

fn change_of(op: &str, entries: Vec<(&str, Value)>) -> Value {
    let mut held = vec![("op".to_owned(), Value::String(op.to_owned()))];
    held.extend(entries.into_iter().map(|(key, value)| (key.to_owned(), value)));
    Value::Map(held)
}

#[test]
fn a_line_patch_writes_its_ends_in_the_line_ends_order() {
    let end = object(&["end", "kind", "node", "side"]);
    let patch = Value::Map(vec![("from".to_owned(), end.clone()), ("to".to_owned(), end)]);
    let written =
        change(change_of("line.patch", vec![("patch", patch.clone()), ("assumed", patch)]));
    let Value::Map(fields) = written else { panic!("a change") };
    for (key, held) in fields.iter().filter(|(key, _)| key == "patch" || key == "assumed") {
        let Value::Map(ends) = held else { panic!("{key}") };
        for (_, end) in ends {
            assert_eq!(keys(end), ["kind", "node", "side", "end"], "{key}");
        }
    }
}

#[test]
fn a_value_that_is_no_object_is_handed_back() {
    assert_eq!(shaped(Value::Bool(true), CORE, flat), Value::Bool(true));
    assert_eq!(anchor(Value::Null), Value::Null);
    assert_eq!(change(Value::Null), Value::Null);
}

use super::{canvas_from, canvas_json, json_value, value_json};
use serde_json::json;
use whiteboard_model::Value;
use whiteboard_model::spatial::SpatialCanvas;

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

// A canvas's fields, their order and every refusal of a malformed one are
// the model's reader's (`whiteboard_model::canvas_value`'s tests); here, only
// that the wire carries a canvas to that reader and back.
#[test]
fn a_canvas_crosses_the_wire_both_ways() {
    let empty = SpatialCanvas::default();
    assert_eq!(canvas_json(&empty), json!(["m", "nodes", ["s"], "edges", ["s"]]));
    assert_eq!(canvas_from(&canvas_json(&empty)), Some(empty));
    let tagged = SpatialCanvas { tags: Some(vec!["t".into()]), ..SpatialCanvas::default() };
    assert_eq!(canvas_from(&canvas_json(&tagged)), Some(tagged));
    assert_eq!(canvas_from(&json!(["m", "nodes", ["s"]])), None);
    assert_eq!(canvas_from(&json!(["f", "zz"])), None);
}
